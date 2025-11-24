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

  for (let step = 0; step < MAX_STEPS; step++) {
    logger.info(`Reasoning step ${step + 1}/${MAX_STEPS}`);

    // Initialize reasoning step
    const reasoningStep: ReasoningStep = {
      step: step + 1,
      toolCalls: [],
      decisions: [],
    };

    // Capture RAG context for first step
    if (step === 0 && ragPayload) {
      reasoningStep.ragContext = {
        queryType: ragPayload.queryType,
        sTotalScore: ragPayload.sTotalScore,
        sourcesCount: ragPayload.sources?.length || 0,
      };
      reasoningStep.decisions.push({
        type: "rag_used",
        description: `RAG context retrieved: ${ragPayload.queryType} query with ${ragPayload.sources?.length || 0} sources`,
        metadata: {
          sTotalScore: ragPayload.sTotalScore,
          queryType: ragPayload.queryType,
        },
      });
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

        // Capture tool execution in reasoning step
        const dataPreview = result.data && typeof result.data === 'object' 
          ? JSON.stringify(result.data).slice(0, 200) 
          : String(result.data || '').slice(0, 200);
        
        reasoningStep.toolCalls.push({
          toolName,
          parameters: parsedArgs,
          result: {
            success: !result.error,
            error: result.error,
            dataPreview,
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
      context.addAssistantMessage(finalText);
      
      // Record reasoning trace
      const durationMs = Date.now() - startTime;
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

