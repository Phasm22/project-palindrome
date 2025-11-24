import readline from "node:readline";
import OpenAI from "openai";
import type { AgentResponse } from "../types/agent";
import { logger } from "../utils/logger";
import { loadTools } from "./tool-loader";
import { executeToolCall } from "./tool-executor";
import { AgentContext } from "./context";
import { SYSTEM_PROMPT } from "./system-prompt";
import { fetchHybridContext, type HybridApiContext } from "./rag-client";
import { getToolRisk, isToolAuthorized, requiresConfirmation, type ToolSession } from "./tool-policy";
import { sanitizeToolPayload } from "./tool-sanitizer";
import { getReasoningTraceStore, type ReasoningStep } from "../pce/api/reasoning-trace-store";
import { AgentEventBus } from "./event-bus";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

function buildToolDefinitions(tools: ReturnType<typeof loadTools>) {
  return tools
    .map((tool) => {
      // Use getSchema() if available (for tools like OPNsense that use getSchema)
      // Otherwise fall back to metadata.parameters
      let parameters: Record<string, any> | undefined;
      
      if (typeof (tool as any).getSchema === "function") {
        const schema = (tool as any).getSchema();
        parameters = schema.parameters;
      } else if (tool.metadata.parameters) {
        parameters = tool.metadata.parameters as Record<string, any>;
      }
      
      if (!parameters) {
        return null;
      }
      
      return {
        type: "function" as const,
        function: {
          name: tool.metadata.name,
          description: tool.metadata.description,
          parameters,
        },
      };
    })
    .filter((def): def is NonNullable<typeof def> => def !== null);
}

function formatRagSummary(rag: HybridApiContext) {
  const lines: string[] = [];
  const fusion = rag.sTotalScore ?? rag.fusionMetrics?.avgTotalScore ?? null;
  lines.push(`RAG_CONTEXT: queryType=${rag.queryType}`);
  if (fusion !== null) {
    lines.push(`FusionScore=${fusion}`);
  }
  lines.push(`CandidateAnswer=${rag.answer}`);
  const topChunks = rag.context.semanticChunks.slice(0, 3);
  if (topChunks.length) {
    lines.push("TopSemanticChunks:");
    topChunks.forEach((chunk) => {
      lines.push(`- ${chunk.sourcePath} (score=${chunk.score.toFixed(2)}): ${chunk.text.slice(0, 140)}...`);
    });
  }
  if (rag.context.structuralPaths.length) {
    lines.push(`StructuralPaths=${rag.context.structuralPaths.length}`);
  }
  return lines.join("\n");
}

async function defaultConfirmHighRisk(toolName: string): Promise<boolean> {
  if (process.env.PCE_AUTO_APPROVE_HIGH_RISK_TOOLS === "true") {
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  return await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Approve high-risk tool "${toolName}"? (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

export type AgentRunOptions = {
  stream?: boolean;
  userId?: string;
  aclGroup?: string;
  confirmHighRisk?: (info: { toolName: string; parameters: Record<string, any>; risk: string }) => Promise<boolean>;
  ragBaseUrl?: string;
  sessionId?: string; // Optional session ID for event tracking
};

function coerceTextContent(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("");
  }
  return String(content);
}

export async function runAgent(
  userInput: string,
  optionsOrStream?: boolean | AgentRunOptions
): Promise<AgentResponse> {
  const options: AgentRunOptions =
    typeof optionsOrStream === "boolean" ? { stream: optionsOrStream } : optionsOrStream ?? {};

  if (options.stream) {
    logger.warn("Streaming mode is not available with tool orchestration; defaulting to non-streaming mode.");
  }

  logger.info(`Agent received input: "${userInput}"`);

  // Generate session ID if not provided
  const sessionId = options.sessionId ?? `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const eventBus = AgentEventBus.getInstance();

  const session: ToolSession = {
    userId: options.userId ?? "agent-user",
    aclGroup: options.aclGroup ?? "admin",
  };

  const confirmHighRisk = options.confirmHighRisk ?? (async ({ toolName }) => defaultConfirmHighRisk(toolName));

  const context = new AgentContext();
  context.addUserMessage(userInput);

  const tools = loadTools();
  const openaiTools = buildToolDefinitions(tools);
  
  // Initialize reasoning trace
  const startTime = Date.now();
  const reasoningSteps: ReasoningStep[] = [];
  let totalToolCalls = 0;
  
  const ragPayload = await fetchHybridContext(userInput, {
    baseUrl: options.ragBaseUrl,
    userId: session.userId,
    aclGroup: session.aclGroup,
  });

  const ragMessage = ragPayload ? [{ role: "system", content: formatRagSummary(ragPayload) }] : [];
  const MAX_STEPS = 5;
  const MAX_TOOL_CALLS_PER_STEP = 5; // Prevent tool call flooding (reduced from 10)
  const seenToolCalls = new Set<string>(); // Track tool calls to prevent infinite loops
  const client = getOpenAIClient();
  
  // Track "all nodes" queries to prevent partial answers
  // Match patterns like "all nodes", "all the nodes", "temperature of all nodes", etc.
  const isAllNodesQuery = /\ball\s+(the\s+)?nodes?\b/i.test(userInput);
  let discoveredNodeCount = 0;
  let queriedNodeCount = 0;
  let expectedProxmoxNodes: string[] = []; // Track which Proxmox nodes we expect to query
  const queriedNodeIds = new Set<string>(); // Track unique physical nodes queried (not aliases)
  
  // For temperature queries, discover Proxmox nodes from SSH config (not Proxmox API)
  // This handles the case where proxBig is standalone and yin/YANG are in a cluster
  if (isAllNodesQuery && /\btemperature|temp\b/i.test(userInput)) {
    try {
      const { loadYaml } = await import("../utils/config");
      const pathModule = await import("path");
      const { fileURLToPath } = await import("url");
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = pathModule.dirname(__filename);
      const configPath = pathModule.join(__dirname, "../config/approved-commands.yaml");
      const config = loadYaml(configPath) as any;
      
      // Find all unique Proxmox nodes (those with "sensors" command in system category)
      // Count unique physical nodes, not aliases - use hostname/IP as the unique identifier
      const uniqueNodes = new Set<string>();
      for (const [hostKey, hostConfig] of Object.entries(config.hosts || {})) {
        const host = hostConfig as any;
        if (host.commands?.system?.includes("sensors")) {
          // This is a Proxmox node - use the hostname/IP as the unique identifier
          uniqueNodes.add(host.hostname || hostKey);
          // Also add all aliases for matching purposes
          expectedProxmoxNodes.push(host.hostname || hostKey);
          if (host.aliases) {
            expectedProxmoxNodes.push(...host.aliases);
          }
        }
      }
      discoveredNodeCount = uniqueNodes.size; // Count unique physical nodes, not aliases
      console.error(`[ALL NODES QUERY DETECTED] Found ${discoveredNodeCount} unique Proxmox nodes from SSH config: ${Array.from(uniqueNodes).join(", ")}`);
      logger.warn(`[ALL NODES QUERY DETECTED] Found ${discoveredNodeCount} unique Proxmox nodes from SSH config: ${Array.from(uniqueNodes).join(", ")}`);
    } catch (error: any) {
      logger.warn(`Failed to load SSH config for node discovery: ${error.message}`);
    }
  } else if (isAllNodesQuery) {
    console.error(`[ALL NODES QUERY DETECTED] Will track node discovery and queries for: "${userInput}"`);
    logger.warn(`[ALL NODES QUERY DETECTED] Will track node discovery and queries for: "${userInput}"`);
  } else {
    console.error(`[NOT ALL NODES] Query: "${userInput}"`);
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    logger.info(`Reasoning step ${step + 1}/${MAX_STEPS}`);
    
    // Emit agent step event
    eventBus.emit({
      type: "agent:step",
      sessionId,
      timestamp: Date.now(),
      data: { step: step + 1, maxSteps: MAX_STEPS, userInput },
    });

    // Initialize reasoning step
    const reasoningStep: ReasoningStep = {
      step: step + 1,
      toolCalls: [],
      decisions: [],
    };

    // Capture RAG context for first step with detailed chunk information
    if (step === 0 && ragPayload) {
      const topChunks = ragPayload.context?.semanticChunks?.slice(0, 5).map(chunk => ({
        sourcePath: chunk.sourcePath || "unknown",
        score: chunk.score || 0,
        textPreview: chunk.text?.slice(0, 200) || "",
        chunkId: chunk.chunkId,
      })) || [];
      
      reasoningStep.ragContext = {
        queryType: ragPayload.queryType,
        sTotalScore: ragPayload.sTotalScore,
        sourcesCount: ragPayload.sources?.length || 0,
        topChunks,
        structuralPaths: ragPayload.context?.structuralPaths?.length || 0,
        fusionMetrics: ragPayload.fusionMetrics ? {
          vectorResults: ragPayload.fusionMetrics.vectorResults || 0,
          graphResults: ragPayload.fusionMetrics.graphResults || 0,
          fusedResults: ragPayload.fusionMetrics.fusedResults || 0,
          prunedResults: ragPayload.fusionMetrics.prunedResults || 0,
        } : undefined,
      };
      
      // Add decision for RAG usage
      reasoningStep.decisions.push({
        type: "rag_used",
        description: `RAG context retrieved: ${ragPayload.queryType} query with ${ragPayload.sources?.length || 0} sources, ${topChunks.length} top chunks`,
        metadata: {
          sTotalScore: ragPayload.sTotalScore,
          queryType: ragPayload.queryType,
          topChunkScores: topChunks.map(c => c.score),
        },
      });
      
      // Add decision for graph usage if fusion metrics show graph results
      if (ragPayload.fusionMetrics?.graphResults && ragPayload.fusionMetrics.graphResults > 0) {
        reasoningStep.graphContext = {
          entitiesFound: ragPayload.fusionMetrics.graphResults,
          relationshipsFound: 0, // Not directly available in fusion metrics
          queryType: ragPayload.queryType,
        };
        reasoningStep.decisions.push({
          type: "graph_used",
          description: `Graph retrieval found ${ragPayload.fusionMetrics.graphResults} entities`,
          metadata: {
            graphResults: ragPayload.fusionMetrics.graphResults,
          },
        });
      }
      
      // Add decision for fusion if both vector and graph were used
      if (ragPayload.fusionMetrics && 
          ragPayload.fusionMetrics.vectorResults > 0 && 
          ragPayload.fusionMetrics.graphResults > 0) {
        reasoningStep.decisions.push({
          type: "fusion_used",
          description: `Fusion combined ${ragPayload.fusionMetrics.vectorResults} vector results with ${ragPayload.fusionMetrics.graphResults} graph results`,
          metadata: {
            vectorResults: ragPayload.fusionMetrics.vectorResults,
            graphResults: ragPayload.fusionMetrics.graphResults,
            fusedResults: ragPayload.fusionMetrics.fusedResults,
          },
        });
      }
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...ragMessage,
      ...context.getMessages(),
    ] as any[];

    const request: any = {
      model: "gpt-4o-mini",
      messages,
    };

    if (openaiTools.length > 0) {
      request.tools = openaiTools;
      request.tool_choice = "auto";
    }

    const response = await client.chat.completions.create(request);
    const message = response.choices[0]?.message;
    
    // Capture LLM response
    reasoningStep.llmResponse = message?.content || "";

    const toolCalls = ((message?.tool_calls as any[]) ?? []) as Array<any>;
    if (toolCalls.length) {
      // Limit tool calls per step to prevent flooding
      if (toolCalls.length > MAX_TOOL_CALLS_PER_STEP) {
        logger.warn(`Too many tool calls in step ${step + 1} (${toolCalls.length}), limiting to ${MAX_TOOL_CALLS_PER_STEP}`);
        reasoningStep.decisions.push({
          type: "limit_reached",
          description: `Tool call limit reached: ${toolCalls.length} calls, limiting to ${MAX_TOOL_CALLS_PER_STEP}`,
          metadata: { originalCount: toolCalls.length, limit: MAX_TOOL_CALLS_PER_STEP },
        });
        toolCalls.splice(MAX_TOOL_CALLS_PER_STEP);
      }

      // Add the assistant message with tool_calls to the context first
      // This is required by OpenAI API: tool messages must follow an assistant message with tool_calls
      const assistantMsg = { 
        role: "assistant" as const, 
        content: message?.content || "",
        tool_calls: toolCalls 
      };
      context.getMessages().push(assistantMsg);
      
      // Check if we can parallelize tool calls (for "all nodes" queries with independent SSH calls)
      const canParallelize = isAllNodesQuery && 
        toolCalls.length > 1 && 
        toolCalls.every(tc => {
          const fnCall = tc.function ?? {};
          const toolName = fnCall.name;
          if (toolName !== "ssh_execute") return false;
          try {
            const args = fnCall.arguments ? JSON.parse(fnCall.arguments) : {};
            return args.command?.includes("sensors");
          } catch {
            return false;
          }
        });
      
      if (canParallelize) {
        // Execute all SSH calls in parallel for "all nodes" queries
        logger.info(`Parallelizing ${toolCalls.length} SSH tool calls for "all nodes" query`);
        const toolPromises = toolCalls.map(async (toolCall) => {
          const fnCall = toolCall.function ?? {};
          const toolName = fnCall.name as string | undefined;
          if (!toolName) return null;
          
          let parsedArgs: Record<string, any> = {};
          try {
            parsedArgs = fnCall.arguments ? JSON.parse(fnCall.arguments) : {};
          } catch {
            return null;
          }
          
          // Check duplicates
          const callSignature = `${toolName}:${JSON.stringify(parsedArgs, Object.keys(parsedArgs).sort())}`;
          if (seenToolCalls.has(callSignature)) {
            logger.warn(`Duplicate tool call detected, skipping: ${callSignature}`);
            return null;
          }
          seenToolCalls.add(callSignature);
          
          const targetTool = tools.find((t) => t.metadata.name === toolName);
          if (!targetTool || !isToolAuthorized(targetTool, session)) {
            return null;
          }
          
          const provenanceId = `tool://${toolName}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const node = parsedArgs.node || parsedArgs.host;
          const execContext = {
            userId: session.userId,
            aclGroup: session.aclGroup,
            node,
          };
          
          // Emit tool:start
          eventBus.emit({
            type: "tool:start",
            sessionId,
            timestamp: Date.now(),
            data: { toolName, parameters: parsedArgs, toolCallId: toolCall.id },
          });
          
          // Execute tool (SSH calls are read-only, no confirmation needed)
          const result = await executeToolCall(
            { toolName, parameters: parsedArgs },
            tools,
            execContext
          );
          
          // Emit tool:complete
          eventBus.emit({
            type: "tool:complete",
            sessionId,
            timestamp: Date.now(),
            data: {
              toolName,
              parameters: parsedArgs,
              toolCallId: toolCall.id,
              success: !result.error,
              error: result.error,
              durationMs: result.durationMs,
            },
          });
          
          return { toolCall, toolName, parsedArgs, result, provenanceId, execContext };
        });
        
        const toolResults = await Promise.all(toolPromises);
        
        // Process results and add to context
        for (const toolResult of toolResults) {
          if (!toolResult) continue;
          
          const { toolCall, toolName, parsedArgs, result, provenanceId } = toolResult;
          
          // Track node queries
          if (isAllNodesQuery && !result.error) {
            const host = parsedArgs.host;
            const proxmoxNodePatterns = [
              { pattern: /prox.*big|172\.16\.0\.10/i, id: "prox_big" },
              { pattern: /^yin$|172\.16\.0\.11/i, id: "yin" },
              { pattern: /^yang$|172\.16\.0\.12/i, id: "yang" },
            ];
            
            let matchedNodeId: string | null = null;
            for (const nodePattern of proxmoxNodePatterns) {
              if (nodePattern.pattern.test(host || "")) {
                matchedNodeId = nodePattern.id;
                break;
              }
            }
            
            if (matchedNodeId && !queriedNodeIds.has(matchedNodeId)) {
              queriedNodeIds.add(matchedNodeId);
              queriedNodeCount++;
              logger.warn(`[ALL NODES TRACKING] Queried ${queriedNodeCount}/${discoveredNodeCount} Proxmox nodes (host: ${host}, node: ${matchedNodeId})`);
            }
          }
          
          // Add to reasoning step
          const dataPreview = result.data && typeof result.data === 'object' 
            ? JSON.stringify(result.data).slice(0, 500) 
            : String(result.data || '').slice(0, 500);
          const dataSize = result.data && typeof result.data === 'object'
            ? JSON.stringify(result.data).length
            : String(result.data || '').length;
          const resultType = result.data 
            ? (Array.isArray(result.data) ? 'array' : typeof result.data)
            : undefined;
          
          reasoningStep.toolCalls.push({
            toolName,
            parameters: parsedArgs,
            result: {
              success: !result.error,
              error: result.error,
              dataPreview,
              dataSize,
              resultType,
            },
            durationMs: result.durationMs ?? 0,
          });
          totalToolCalls++;
          
          // Add to context
          const sanitizedData = sanitizeToolPayload(result.data);
          context.addToolResult(toolCall.id, toolName, {
            provenanceId,
            success: !result.error,
            data: sanitizedData,
            error: result.error ?? null,
            durationMs: result.durationMs ?? 0,
          });
        }
      } else {
        // Sequential execution (original behavior)
        for (const toolCall of toolCalls) {
        // Create a signature for this tool call to detect duplicates
        const fnCall = toolCall.function ?? {};
        const toolName = fnCall.name as string | undefined;
        if (!toolName) continue;
        
        let parsedArgs: Record<string, any> = {};
        try {
          parsedArgs = fnCall.arguments ? JSON.parse(fnCall.arguments) : {};
        } catch {
          // Continue even if parsing fails
        }
        
        // Create a signature: toolName + sorted stringified args
        const callSignature = `${toolName}:${JSON.stringify(parsedArgs, Object.keys(parsedArgs).sort())}`;
        if (seenToolCalls.has(callSignature)) {
          logger.warn(`Duplicate tool call detected, skipping: ${callSignature}`);
          reasoningStep.decisions.push({
            type: "duplicate_detected",
            description: `Duplicate tool call detected: ${toolName}`,
            metadata: { toolName, parameters: parsedArgs },
          });
          context.addToolResult(toolCall.id, toolName, {
            provenanceId: `tool://${toolName}/duplicate-${Date.now()}`,
            success: false,
            error: "Duplicate tool call detected - this exact call was already made in this session",
          });
          continue;
        }
        seenToolCalls.add(callSignature);
        
        // For proxmox_write, also check for similar calls (same action + vmid + node, even if other params differ)
        if (toolName === "proxmox_write" && parsedArgs.action && parsedArgs.vmid && parsedArgs.node) {
          const similarSignature = `${toolName}:${parsedArgs.action}:${parsedArgs.vmid}:${parsedArgs.node}`;
          if (seenToolCalls.has(similarSignature)) {
            logger.warn(`Similar proxmox_write call detected, skipping: ${similarSignature}`);
            reasoningStep.decisions.push({
              type: "duplicate_detected",
              description: `Similar proxmox_write call detected: ${parsedArgs.action} on VMID ${parsedArgs.vmid}`,
              metadata: { toolName, action: parsedArgs.action, vmid: parsedArgs.vmid, node: parsedArgs.node },
            });
            context.addToolResult(toolCall.id, toolName, {
              provenanceId: `tool://${toolName}/similar-duplicate-${Date.now()}`,
              success: false,
              error: `A similar operation (${parsedArgs.action}) was already attempted for VMID ${parsedArgs.vmid} on node ${parsedArgs.node} in this session`,
            });
            continue;
          }
          seenToolCalls.add(similarSignature);
        }
        
        // Record tool choice decision
        reasoningStep.decisions.push({
          type: "tool_choice",
          description: `Selected tool: ${toolName}`,
          metadata: { toolName, parameters: parsedArgs },
        });
        const targetTool = tools.find((t) => t.metadata.name === toolName);
        const provenanceId = `tool://${toolName}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        
        // Emit tool:start event
        eventBus.emit({
          type: "tool:start",
          sessionId,
          timestamp: Date.now(),
          data: { toolName, parameters: parsedArgs, toolCallId: toolCall.id },
        });

        // parsedArgs already parsed above for duplicate detection
        logger.debug(`Tool call parsed: ${toolName}`, {
          parsedArgs,
          argKeys: Object.keys(parsedArgs),
        });

        if (!targetTool) {
          context.addToolResult(toolCall.id, toolName, {
            provenanceId,
            success: false,
            error: "Tool not registered",
          });
          continue;
        }

        if (!isToolAuthorized(targetTool, session)) {
          const errorMsg = `ACL group ${session.aclGroup} is not authorized to run ${toolName}`;
          logger.error(errorMsg);
          context.addToolResult(toolCall.id, toolName, {
            provenanceId,
            success: false,
            error: errorMsg,
          });
          continue;
        }

        // Extract node and vmid from parameters for audit trail
        const node = parsedArgs.node || parsedArgs.host;
        const vmid = parsedArgs.vmid || parsedArgs.vmId;
        
        // Build execution context for audit trail
        const execContext = {
          userId: session.userId,
          aclGroup: session.aclGroup,
          node,
          vmid: typeof vmid === "number" ? vmid : undefined,
        };

        // For proxmox_write operations, do a dry-run first to check if action is needed
        // This avoids prompting for confirmation when the VM is already in the desired state
        let result: ExecutionResult;
        if (toolName === "proxmox_write" && parsedArgs.action) {
          const dryRunResult = await executeToolCall(
            { toolName, parameters: { ...parsedArgs, dryRun: true } },
            tools,
            execContext
          );
          
          // Check if the dry-run indicates no action is needed
          const noActionNeeded = 
            dryRunResult.data?.status === "already_running" ||
            dryRunResult.data?.status === "already_stopped" ||
            dryRunResult.data?.message?.includes("already") ||
            dryRunResult.data?.message?.includes("No action needed");
          
          if (noActionNeeded) {
            // No action needed, return the dry-run result without prompting
            result = dryRunResult;
          } else {
            // Action is needed, prompt for confirmation
            if (requiresConfirmation(targetTool)) {
              const approved = await confirmHighRisk({
                toolName,
                parameters: parsedArgs,
                risk: getToolRisk(targetTool),
              });

              if (!approved) {
                context.addToolResult(toolCall.id, toolName, {
                  provenanceId,
                  success: false,
                  error: "High-risk action was not approved",
                });
                continue;
              }
            }
            // Execute the actual operation
            result = await executeToolCall(
              { toolName, parameters: parsedArgs },
              tools,
              execContext
            );
          }
        } else {
          // For other tools, prompt for confirmation if needed
          if (requiresConfirmation(targetTool)) {
            const approved = await confirmHighRisk({
              toolName,
              parameters: parsedArgs,
              risk: getToolRisk(targetTool),
            });

            if (!approved) {
              context.addToolResult(toolCall.id, toolName, {
                provenanceId,
                success: false,
                error: "High-risk action was not approved",
              });
              continue;
            }
          }

          result = await executeToolCall(
            { toolName, parameters: parsedArgs },
            tools,
            execContext
          );
        }

        // Emit tool:complete event
        eventBus.emit({
          type: "tool:complete",
          sessionId,
          timestamp: Date.now(),
          data: {
            toolName,
            parameters: parsedArgs,
            toolCallId: toolCall.id,
            success: !result.error,
            error: result.error,
            durationMs: result.durationMs,
            dataPreview: result.data && typeof result.data === 'object' 
              ? JSON.stringify(result.data).slice(0, 200) 
              : String(result.data || '').slice(0, 200),
          },
        });

        if (result.error) {
          logger.error(`Tool execution failed: ${toolName}`, {
            error: result.error,
            parameters: parsedArgs,
          });
        } else {
          logger.debug(`Tool execution succeeded: ${toolName}`, {
            dataKeys: result.data && typeof result.data === 'object' ? Object.keys(result.data) : [],
          });
        }

        // Track node discovery and queries for "all nodes" validation (BEFORE sanitization)
        if (isAllNodesQuery && !result.error) {
          console.error(`[ALL NODES TRACKING] Tool: ${toolName}, Action: ${parsedArgs.action}, Command: ${parsedArgs.command}`);
          logger.warn(`[ALL NODES TRACKING] Tool: ${toolName}, Action: ${parsedArgs.action}, Command: ${parsedArgs.command}`);
          
          // For temperature queries, we use SSH config discovery (already done above)
          // For other "all nodes" queries, use Proxmox API discovery
          if (toolName === "proxmox_readonly" && parsedArgs.action === "list_nodes" && expectedProxmoxNodes.length === 0) {
            // Response structure: { data: { nodes: [...], count: ... } }
            const data = result.data as any;
            const nodes = data?.nodes || data?.data?.nodes || [];
            discoveredNodeCount = Array.isArray(nodes) ? nodes.length : (data?.count || 0);
            logger.warn(`[ALL NODES TRACKING] Discovered ${discoveredNodeCount} nodes from Proxmox API`, {
              nodesArray: Array.isArray(nodes) ? nodes.length : 'not array',
              countField: data?.count,
              dataKeys: data && typeof data === 'object' ? Object.keys(data) : [],
              rawData: JSON.stringify(data).slice(0, 500),
            });
          }
          
          // Track SSH queries for temperature - check if this host is one of our expected Proxmox nodes
          if (toolName === "ssh_execute" && parsedArgs.command?.includes("sensors")) {
            const host = parsedArgs.host;
            // For temperature queries, we expect 3 Proxmox nodes: prox_big, yin, yang
            // Match by checking if host is one of the known Proxmox nodes (flexible matching)
            const proxmoxNodePatterns = [
              { pattern: /prox.*big|172\.16\.0\.10/i, id: "prox_big" },  // prox_big, proxBig, 172.16.0.10
              { pattern: /^yin$|172\.16\.0\.11/i, id: "yin" },          // yin, 172.16.0.11
              { pattern: /^yang$|172\.16\.0\.12/i, id: "yang" },        // yang, YANG, 172.16.0.12
            ];
            
            let matchedNodeId: string | null = null;
            if (expectedProxmoxNodes.length > 0) {
              // Try to match against expected nodes
              for (const nodePattern of proxmoxNodePatterns) {
                if (nodePattern.pattern.test(host || "")) {
                  matchedNodeId = nodePattern.id;
                  break;
                }
              }
            } else {
              // Fallback: use pattern matching
              for (const nodePattern of proxmoxNodePatterns) {
                if (nodePattern.pattern.test(host || "")) {
                  matchedNodeId = nodePattern.id;
                  break;
                }
              }
            }
              
            if (matchedNodeId) {
              // Only increment if we haven't queried this physical node yet
              if (!queriedNodeIds.has(matchedNodeId)) {
                queriedNodeIds.add(matchedNodeId);
                queriedNodeCount++;
                logger.warn(`[ALL NODES TRACKING] Queried ${queriedNodeCount}/${discoveredNodeCount} Proxmox nodes (host: ${host}, node: ${matchedNodeId})`);
              } else {
                logger.warn(`[ALL NODES TRACKING] Duplicate query for node ${matchedNodeId} (host: ${host}) - not counted`);
              }
            } else {
              logger.warn(`[ALL NODES TRACKING] Sensors query on non-Proxmox host: ${host} (not counted)`);
            }
          }
        }

        // Capture tool execution in reasoning step with enhanced details
        const dataPreview = result.data && typeof result.data === 'object' 
          ? JSON.stringify(result.data).slice(0, 500) 
          : String(result.data || '').slice(0, 500);
        
        const dataSize = result.data && typeof result.data === 'object'
          ? JSON.stringify(result.data).length
          : String(result.data || '').length;
        
        const resultType = result.data 
          ? (Array.isArray(result.data) ? 'array' : typeof result.data)
          : undefined;
        
        reasoningStep.toolCalls.push({
          toolName,
          parameters: parsedArgs,
          result: {
            success: !result.error,
            error: result.error,
            dataPreview,
            dataSize,
            resultType,
          },
          durationMs: result.durationMs ?? 0,
        });
        totalToolCalls++;

        const sanitizedData = sanitizeToolPayload(result.data);

        context.addToolResult(toolCall.id, toolName, {
          provenanceId,
          success: !result.error,
          data: sanitizedData,
          error: result.error ?? null,
          durationMs: result.durationMs ?? 0,
        });
        }
      }

      // Record this reasoning step
      reasoningSteps.push(reasoningStep);
      continue;
    }

    // Record step even if no tool calls
    if (message?.content) {
      reasoningStep.llmResponse = message.content;
    }
    reasoningSteps.push(reasoningStep);

    const finalText = coerceTextContent(message?.content).trim();
    if (finalText) {
      // Validate "all nodes" queries - prevent partial answers
      if (isAllNodesQuery) {
        logger.warn(`[ALL NODES VALIDATION] discovered=${discoveredNodeCount}, queried=${queriedNodeCount}, hasText=${!!finalText}`);
        if (discoveredNodeCount > 0 && queriedNodeCount < discoveredNodeCount) {
          logger.error(`[ALL NODES VALIDATION] BLOCKING partial answer: discovered ${discoveredNodeCount} nodes but only queried ${queriedNodeCount}`);
          reasoningStep.decisions.push({
            type: "validation_failed",
            description: `Partial answer prevented: need to query all ${discoveredNodeCount} nodes, only ${queriedNodeCount} queried`,
            metadata: { discoveredNodeCount, queriedNodeCount },
          });
          // Force continuation by adding a user message to the context
          context.addUserMessage(`You have not queried all discovered nodes yet. You discovered ${discoveredNodeCount} nodes but have only queried ${queriedNodeCount}. You MUST continue querying the remaining ${discoveredNodeCount - queriedNodeCount} node(s) before providing an answer. Do NOT provide a text response yet - make more tool calls instead.`);
          reasoningSteps.push(reasoningStep);
          continue; // Force another iteration
        } else if (discoveredNodeCount === 0 && queriedNodeCount > 0) {
          // Nodes were queried but we didn't track discovery - might be a tracking issue
          logger.warn(`All nodes query: nodes were queried (${queriedNodeCount}) but discovery count is 0 - tracking may have failed`);
        }
      }
      
      context.addAssistantMessage(finalText);
      
      // Emit agent:final event
      const durationMs = Date.now() - startTime;
      eventBus.emit({
        type: "agent:final",
        sessionId,
        timestamp: Date.now(),
        data: {
          text: finalText,
          totalSteps: step + 1,
          totalToolCalls,
          durationMs,
        },
      });
      
      // Record reasoning trace
      try {
        const traceStore = getReasoningTraceStore();
        await traceStore.recordTrace({
          userId: session.userId,
          aclGroup: session.aclGroup,
          userInput,
          finalResponse: finalText,
          steps: reasoningSteps,
          totalSteps: reasoningSteps.length,
          totalToolCalls,
          maxStepsReached: false,
          timestamp: new Date(),
          durationMs,
        });
      } catch (error: any) {
        logger.warn("Failed to record reasoning trace", { error: error.message });
      }
      
      return { text: finalText };
    }
  }

  // Max steps reached - record trace
  const durationMs = Date.now() - startTime;
  try {
    const traceStore = getReasoningTraceStore();
    await traceStore.recordTrace({
      userId: session.userId,
      aclGroup: session.aclGroup,
      userInput,
      finalResponse: "Max reasoning depth reached. Please try a simpler query.",
      steps: reasoningSteps,
      totalSteps: reasoningSteps.length,
      totalToolCalls,
      maxStepsReached: true,
      timestamp: new Date(),
      durationMs,
    });
  } catch (error: any) {
    logger.warn("Failed to record reasoning trace", { error: error.message });
  }

  return { text: "Max reasoning depth reached. Please try a simpler query." };
}

