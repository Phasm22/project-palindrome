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
import type { BaseTool } from "../tools/BaseTool";
import { detectComputeIntent, type ComputeIntent } from "../reasoning/compute-intents";
import {
  describeClusterChain,
  listVmsByNodeChain,
  listVmsWithoutAgentChain,
  listStoppedVmsChain,
  findVmByIdChain,
  resolveVmDetailsChain,
  type ResolvedVmDetails,
} from "../reasoning/chains/compute";
import { detectNetworkIntent, type NetworkIntent } from "../reasoning/detectNetworkIntent";
import {
  describeNetworkChain,
  listNodeInterfacesChain,
  reachabilityChain,
  vmsBySubnetChain,
} from "../reasoning/chains/network";
import { detectFirewallIntent, type FirewallIntent } from "../reasoning/detectFirewallIntent";
import {
  listFirewallRulesChain,
  firewallRulesByChainChain,
  rulesAllowingSubnetChain,
  rulesBlockingSubnetChain,
  exposureMapChain,
} from "../reasoning/chains/firewall";
import { detectExposureIntent, type ExposureIntent } from "../reasoning/detectExposureIntent";
import {
  analyzeVmExposureChain,
  listVmsExposedToSubnetChain,
  attackPathChain,
  listInternetExposedVmsChain,
} from "../reasoning/chains/exposure";
import { detectActionIntent } from "../reasoning/action-intents";
import {
  loadKnownEntitiesFromProxmox,
} from "../reasoning/clarification";
import { classifyAndRoute } from "../reasoning/intent-router";
import { reclassifyIntentWithContext, FailureTracker, type FailureContext } from "../reasoning/failure-reclassification";

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

/**
 * Clean up RAG answers by removing verbose citations and formatting
 * 
 * Removes:
 * - Source citations like "[Source N]" or "Source: [Source N]"
 * - Verbose explanations about where information can be found
 * - Redundant notes about variations or updates
 * - Unnecessary formatting markers
 * 
 * Keeps:
 * - The actual answer/data
 * - Essential context
 */
function cleanupRagAnswer(answer: string): string {
  if (!answer) return answer;
  
  let cleaned = answer;
  
  // Remove source citations: "[Source N]" or "Source: [Source N]"
  cleaned = cleaned.replace(/\[Source \d+\]/gi, '');
  cleaned = cleaned.replace(/Source:\s*\[Source \d+\]/gi, '');
  cleaned = cleaned.replace(/according to.*?Source \d+/gi, '');
  cleaned = cleaned.replace(/found in.*?Source \d+/gi, '');
  cleaned = cleaned.replace(/provided in.*?Source \d+/gi, '');
  cleaned = cleaned.replace(/according to one of the entries provided in/gi, '');
  cleaned = cleaned.replace(/according to.*?entries?/gi, '');
  
  // Remove verbose explanations about where information can be found
  cleaned = cleaned.replace(/This information can be found.*?\n/gi, '');
  cleaned = cleaned.replace(/The following line.*?\n/gi, '');
  cleaned = cleaned.replace(/under the.*?field.*?\n/gi, '');
  cleaned = cleaned.replace(/in the following.*?\n/gi, '');
  cleaned = cleaned.replace(/The information.*?found.*?\n/gi, '');
  
  // Remove notes about variations or updates
  cleaned = cleaned.replace(/Note that.*?over time\./gi, '');
  cleaned = cleaned.replace(/which might indicate.*?over time\./gi, '');
  cleaned = cleaned.replace(/might indicate.*?variations/gi, '');
  cleaned = cleaned.replace(/Note that this value.*?difference.*?\n/gi, '');
  
  // Remove code block markers - extract just the data, not the formatting
  cleaned = cleaned.replace(/```\s*\n?([^`]+)\n?\s*```/g, '');
  
  // Remove "The other relevant details" sections that are redundant
  cleaned = cleaned.replace(/The other relevant details.*$/gis, '');
  
  // Remove standalone "Source:" lines
  cleaned = cleaned.replace(/^Source:.*$/gim, '');
  
  // Extract key information patterns (like "Memory: X / Y") and remove duplicates
  // If we have a pattern like "Memory: X / Y" in a code block and also in text, keep the text version
  const memoryPattern = /Memory:\s*([\d.]+)\s*(GB|MB|TB)\s*\/\s*([\d.]+)\s*(GB|MB|TB)/gi;
  const memoryMatches = [...cleaned.matchAll(memoryPattern)];
  if (memoryMatches.length > 1) {
    // Keep the first occurrence, remove standalone "Memory: X / Y" lines
    cleaned = cleaned.replace(/^Memory:\s*[\d.]+\s*(GB|MB|TB)\s*\/\s*[\d.]+\s*(GB|MB|TB)\s*$/gim, '');
  }
  
  // Remove trailing periods after removing citations
  cleaned = cleaned.replace(/\s+\.\s*$/gm, '.');
  
  // Clean up multiple newlines and spaces
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ');
  cleaned = cleaned.replace(/\n\s+\./g, '.');
  
  // Remove leading/trailing whitespace from each line
  cleaned = cleaned.split('\n').map(line => line.trim()).filter(line => line.length > 0).join('\n');
  
  // Remove leading/trailing whitespace
  cleaned = cleaned.trim();
  
  // If answer starts with "The" and contains key info, simplify it
  // Example: "The memory usage for VM 101 is 14.36 GB / 16 GB." -> "VM 101 memory usage: 14.36 GB / 16 GB"
  if (cleaned.match(/^The\s+\w+\s+usage.*?is\s+([\d.]+\s*(GB|MB|TB)\s*\/\s*[\d.]+\s*(GB|MB|TB))/i)) {
    cleaned = cleaned.replace(/^The\s+(\w+)\s+usage\s+for\s+(.+?)\s+is\s+([\d.]+\s*(GB|MB|TB)\s*\/\s*[\d.]+\s*(GB|MB|TB))\.?/i, 
      (match, metric, entity, value) => {
        const entityClean = entity.replace(/\s*\([^)]+\)\s*/, '').trim();
        return `${entityClean} ${metric} usage: ${value}`;
      });
  }
  
  // If the answer is just about sources or formatting, return a simplified version
  if (cleaned.length < 20 && cleaned.toLowerCase().includes('source')) {
    return "I found the information, but the answer needs to be extracted from the source data.";
  }
  
  return cleaned;
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

async function executeComputeIntent(
  intent: ComputeIntent,
  tools: BaseTool[],
  session: ToolSession
): Promise<string | null> {
  try {
    switch (intent.type) {
      case "describe_cluster":
        return await describeClusterChain(tools, session);
      case "vms_by_node":
        return await listVmsByNodeChain(tools, session, intent.nodeName);
      case "vms_without_agent":
        return await listVmsWithoutAgentChain(tools, session);
      case "stopped_vms_on_node":
        return await listStoppedVmsChain(tools, session, intent.nodeName);
      case "find_vm_by_id":
        return await findVmByIdChain(tools, session, intent.vmId);
      default:
        return null;
    }
  } catch (error: any) {
    logger.error(`Twin reasoning chain failed: ${error.message}`);
    return null;
  }
}

async function executeNetworkIntent(
  intent: NetworkIntent,
  tools: BaseTool[],
  session: ToolSession
): Promise<string | null> {
  try {
    switch (intent.type) {
      case "describe_network":
        return await describeNetworkChain(tools, session);
      case "node_interfaces":
        return await listNodeInterfacesChain(tools, session, intent.nodeName);
      case "vms_by_subnet":
        return await vmsBySubnetChain(tools, session, intent.subnet);
      case "reachability":
        return await reachabilityChain(tools, session, intent.fromId);
      default:
        return null;
    }
  } catch (error: any) {
    logger.error(`Network reasoning chain failed: ${error.message}`);
    return null;
  }
}

async function executeExposureIntent(
  intent: ExposureIntent,
  tools: BaseTool[],
  session: ToolSession
): Promise<string | null> {
  try {
    const toolsMap = new Map(tools.map((t) => [t.metadata.name, t]));
    switch (intent.type) {
      case "vm_exposure":
        return await analyzeVmExposureChain(intent.vmId, toolsMap, session as any);
      case "vms_exposed_to_subnet":
        return await listVmsExposedToSubnetChain(intent.subnetCidr, toolsMap, session as any);
      case "attack_path":
        return await attackPathChain(intent.fromSubnet, intent.toVmId, toolsMap, session as any);
      case "internet_exposed":
        return await listInternetExposedVmsChain(toolsMap, session as any);
      default:
        return null;
    }
  } catch (error: any) {
    logger.error(`Exposure reasoning chain failed: ${error.message}`);
    return null;
  }
}

async function executeFirewallIntent(
  intent: FirewallIntent,
  tools: BaseTool[],
  session: ToolSession
): Promise<string | null> {
  try {
    switch (intent.type) {
      case "list_rules":
        return await listFirewallRulesChain(tools, session);
      case "rules_by_chain":
        return await firewallRulesByChainChain(intent.chain, tools, session);
      case "rules_allowing_subnet":
        return await rulesAllowingSubnetChain(intent.subnet, tools, session);
      case "rules_blocking_subnet":
        return await rulesBlockingSubnetChain(intent.subnet, tools, session);
      case "exposure_map":
        return await exposureMapChain(intent.vmId, tools, session);
      default:
        return null;
    }
  } catch (error: any) {
    logger.error(`Firewall reasoning chain failed: ${error.message}`);
    return null;
  }
}

export type AgentRunOptions = {
  stream?: boolean;
  userId?: string;
  aclGroup?: string;
  confirmHighRisk?: (info: { toolName: string; parameters: Record<string, any>; risk: string }) => Promise<boolean>;
  ragBaseUrl?: string;
  sessionId?: string; // Optional session ID for event tracking
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>; // Previous messages in conversation
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

  const startTime = Date.now();
  // Generate session ID if not provided
  const sessionId = options.sessionId ?? `session-${startTime}-${Math.random().toString(36).slice(2, 9)}`;
  const eventBus = AgentEventBus.getInstance();

  const emitStepEvent = (data: Record<string, any>) => {
    eventBus.emit({
      type: "agent:step",
      sessionId,
      timestamp: Date.now(),
      data,
    });
  };

  const emitFinalEvent = (text: string, extra: Record<string, any> = {}) => {
    eventBus.emit({
      type: "agent:final",
      sessionId,
      timestamp: Date.now(),
      data: {
        text,
        totalSteps: extra.totalSteps ?? 0,
        totalToolCalls: extra.totalToolCalls ?? 0,
        durationMs: Date.now() - startTime,
        ...extra,
      },
    });
  };

  const session: ToolSession = {
    userId: options.userId ?? "agent-user",
    aclGroup: options.aclGroup ?? "admin",
  };

  const confirmHighRisk = options.confirmHighRisk ?? (async ({ toolName }) => defaultConfirmHighRisk(toolName));

  const context = new AgentContext();
  
  // Add conversation history to context (if provided)
  if (options.conversationHistory && options.conversationHistory.length > 0) {
    for (const msg of options.conversationHistory) {
      if (msg.role === "user") {
        context.addUserMessage(msg.content);
      } else if (msg.role === "assistant") {
        context.addAssistantMessage(msg.content);
      }
    }
  }
  
  // Add current user message
  context.addUserMessage(userInput);

  const tools = loadTools();
  
  // Track failures to prevent retry loops (must be declared before classification)
  const failureTracker = new FailureTracker();

  // Helper to record reasoning trace for early returns
  const recordEarlyReturnTrace = async (answer: string, intent: string, toolCalls: number = 1): Promise<string | undefined> => {
    const durationMs = Date.now() - startTime;
    try {
      const traceStore = getReasoningTraceStore();
      const traceId = await traceStore.recordTrace({
        userId: session.userId,
        aclGroup: session.aclGroup,
        userInput,
        finalResponse: answer,
        steps: [{
          step: 1,
          toolCalls: [{
            toolName: "twin_query",
            parameters: { intent },
            result: { success: true },
            durationMs,
          }],
          decisions: [{
            type: "tool_choice",
            description: `Used twin-first reasoning chain for ${intent}`,
            metadata: { intent, mode: "twin_first" },
          }],
        }],
        totalSteps: 1,
        totalToolCalls: toolCalls,
        maxStepsReached: false,
        timestamp: new Date(),
        durationMs,
      });
      return traceId;
    } catch (error: any) {
      logger.warn("Failed to record reasoning trace for early return", { error: error.message });
      return undefined;
    }
  };

  // ============================================================
  // CLARIFICATION CHECK - detect typos and ambiguous queries
  // ============================================================
  
  // Lazily load known entities from Proxmox (first run only)
  await loadKnownEntitiesFromProxmox(async (toolName, params) => {
    const tool = tools.find(t => t.metadata.name === toolName);
    if (!tool) return null;
    return tool.execute(params, { toolName, startedAt: Date.now() });
  });
  
  // Classify intent using probabilistic classifier
  const { classification, routing } = classifyAndRoute(userInput);
  
  // Store original classification for confidence monotonicity
  failureTracker.setOriginalClassification(userInput, classification);
  
  logger.info("Intent classification", {
    input: userInput.slice(0, 100),
    type: classification.type,
    confidence: classification.confidence,
    metadata: classification.metadata,
    route: routing.route,
  });
  
  // Handle clarification requests (low confidence or genuinely ambiguous)
  // BUT: If we have domain metadata, try RAG first - it might have the answer
  // EXCEPT: Skip RAG for real-time metric queries (uptime, memory, cpu, etc.) - these need tools
  if (routing.route === "clarification") {
    logger.info("Input needs clarification", {
      confidence: classification.confidence,
      type: classification.type,
      metadata: classification.metadata,
    });
    
    // Detect real-time metric queries that should use tools, not RAG
    // These queries need current/live data that RAG can't provide accurately
    const realTimeMetricPatterns = [
      /\b(uptime|memory|ram|cpu|disk|load|temperature|temp|status)\s+(of|for)\s+/i,
      /\b(what|what's|what is)\s+(the\s+)?(uptime|memory|ram|cpu|disk|load|temperature|temp|status)\s+(of|for)\s+/i,
      /\b(how\s+much\s+)?(memory|ram|cpu|disk)\s+(does|has|is)\s+/i,
      /\b(how\s+long\s+)?(has|is)\s+.*\s+(been\s+)?(running|up)\b/i,
    ];
    
    const isRealTimeMetricQuery = realTimeMetricPatterns.some(pattern => pattern.test(userInput));
    
    // If we have domain metadata, try RAG first - the data might answer the question
    // This leverages the PCE data we're collecting even when confidence is low
    // BUT: Skip RAG for real-time metric queries - they need tools for accurate data
    if (classification.metadata?.domain && classification.confidence >= 0.2 && !isRealTimeMetricQuery) {
      logger.info("Low confidence but domain detected - trying RAG before clarification", {
        domain: classification.metadata.domain,
        confidence: classification.confidence,
      });
      
      // Fetch RAG to see if we can answer from collected data
      const ragPayload = await fetchHybridContext(userInput, {
        baseUrl: options.ragBaseUrl,
        userId: session.userId,
        aclGroup: session.aclGroup,
      });
      
      // If RAG has a good answer (high score), use it instead of asking for clarification
      if (ragPayload && ragPayload.answer && ragPayload.sTotalScore && ragPayload.sTotalScore > 0.3) {
        logger.info("RAG provided answer despite low classification confidence", {
          sTotalScore: ragPayload.sTotalScore,
          answerLength: ragPayload.answer.length,
        });
        
        // Clean up the RAG answer (remove verbose citations, formatting)
        const cleanedAnswer = cleanupRagAnswer(ragPayload.answer);
        
        // Record trace
        try {
          const traceStore = getReasoningTraceStore();
          await traceStore.recordTrace({
            userId: session.userId,
            aclGroup: session.aclGroup,
            userInput,
            finalResponse: cleanedAnswer,
            steps: [{
              step: 1,
              toolCalls: [],
              decisions: [{
                type: "rag_answer_used",
                description: `Low confidence (${classification.confidence.toFixed(2)}) but RAG provided answer (score: ${ragPayload.sTotalScore.toFixed(2)})`,
                metadata: { classification, routing, ragScore: ragPayload.sTotalScore },
              }],
            }],
            totalSteps: 1,
            totalToolCalls: 0,
            maxStepsReached: false,
            timestamp: new Date(),
            durationMs: Date.now() - startTime,
          });
        } catch (error: any) {
          logger.warn("Failed to record RAG answer trace", { error: error.message });
        }
        
        // Small delay to ensure SSE stream is subscribed before emitting
        await new Promise(resolve => setTimeout(resolve, 100));
        
        emitFinalEvent(cleanedAnswer, { 
          ragAnswer: true,
          ragScore: ragPayload.sTotalScore,
          classification,
        });
        return { text: cleanedAnswer };
      }
      
      // RAG didn't have a good answer, fall through to clarification
      logger.info("RAG did not provide sufficient answer, proceeding with clarification", {
        ragScore: ragPayload?.sTotalScore,
        hasAnswer: !!ragPayload?.answer,
      });
    } else if (isRealTimeMetricQuery) {
      // Real-time metric queries should use tools, not RAG
      logger.info("Skipping RAG for real-time metric query - will use tools instead", {
        query: userInput.slice(0, 100),
        domain: classification.metadata?.domain,
      });
    }
    
    // Generate clarification message based on classification
    let clarificationMessage: string;
    if (classification.confidence < 0.2) {
      clarificationMessage = "I'm not sure what you're asking. Could you rephrase your question?";
    } else if (classification.metadata?.domain) {
      const domain = classification.metadata.domain;
      const suggestions: string[] = [];
      
      if (domain === "metrics") {
        suggestions.push("Are you asking about temperature, CPU, memory, or status?");
      } else if (domain === "compute") {
        suggestions.push("Are you asking about VMs, containers, or nodes?");
      } else if (domain === "firewall") {
        suggestions.push("Are you asking about firewall rules, chains, or exposure?");
      } else if (domain === "network") {
        suggestions.push("Are you asking about network interfaces, subnets, or connectivity?");
      }
      
      if (suggestions.length > 0) {
        clarificationMessage = `I understand you're asking about ${domain}, but could you be more specific?\n\n${suggestions.join("\n")}`;
      } else {
        clarificationMessage = "Could you clarify what you'd like to know or do?";
      }
    } else {
      clarificationMessage = "Could you clarify what you'd like to know or do?";
    }
    
    // Record trace for clarification
    try {
      const traceStore = getReasoningTraceStore();
      await traceStore.recordTrace({
        userId: session.userId,
        aclGroup: session.aclGroup,
        userInput,
        finalResponse: clarificationMessage,
        steps: [{
          step: 1,
          toolCalls: [],
          decisions: [{
            type: "clarification_requested",
            description: `Confidence ${classification.confidence.toFixed(2)} below threshold for ${classification.type} intent`,
            metadata: { classification, routing },
          }],
        }],
        totalSteps: 1,
        totalToolCalls: 0,
        maxStepsReached: false,
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
      });
    } catch (error: any) {
      logger.warn("Failed to record clarification trace", { error: error.message });
    }
    
    // Small delay to ensure SSE stream is subscribed before emitting
    await new Promise(resolve => setTimeout(resolve, 100));
    
    emitFinalEvent(clarificationMessage, { 
      clarification: true, 
      needsResponse: true, 
      classification,
      traceId: undefined, // Will be set if trace was recorded above
    });
    return { text: clarificationMessage };
  }

  // Check action intent FIRST (before ALL query intents)
  // This prevents action requests from being treated as queries
  const actionIntent = detectActionIntent(userInput);
  let resolvedVmContext: string | null = null;
  
  if (actionIntent) {
    logger.info("Detected action intent", { intent: actionIntent.type });
    
    // For VM-related actions, resolve VM details (node, vmid, type) before letting LLM proceed
    // This ensures the LLM has the correct parameters for write operations
    const vmActionsNeedingResolution = ["destroy_vm", "start_vm", "stop_vm", "restart_vm"];
    if (vmActionsNeedingResolution.includes(actionIntent.type)) {
      const vmNameOrId = 
        (actionIntent as any).name || 
        (actionIntent as any).vmId || 
        null;
      
      if (vmNameOrId) {
        try {
          logger.info("Resolving VM details before action", { vmNameOrId, intent: actionIntent.type });
          const resolved = await resolveVmDetailsChain(tools, session, vmNameOrId);
          
          if (resolved.found) {
            resolvedVmContext = `VM DETAILS (resolved from cluster_resources):
- VM Name: ${resolved.name}
- VMID: ${resolved.vmid}
- Node: ${resolved.node}
- Type: ${resolved.type}
- Status: ${resolved.status}
${resolved.ambiguous ? `\n⚠️ WARNING: Multiple VMs matched "${vmNameOrId}". Using first match. All matches:\n${resolved.matches?.map(m => `  - ${m.name} (vmid=${m.vmid}, node=${m.node}, type=${m.type})`).join("\n")}` : ""}

IMPORTANT: When calling proxmox_write, you MUST use:
  - node: "${resolved.node}"
  - vmid: ${resolved.vmid}
  - type: "${resolved.type}"`;
            
            logger.info("VM details resolved successfully", { 
              vmNameOrId, 
              resolved: { vmid: resolved.vmid, node: resolved.node, type: resolved.type }
            });
          } else {
            resolvedVmContext = `VM RESOLUTION FAILED: Could not find VM "${vmNameOrId}" in cluster_resources. The VM may not exist or may be on a different cluster. Please verify the VM name and try again.`;
            logger.warn("VM resolution failed", { vmNameOrId });
          }
        } catch (error: any) {
          logger.error("Error resolving VM details", { vmNameOrId, error: error.message });
        }
      }
    }
    // Skip ALL query intents (including firewall) - let the LLM handle action execution
    // The LLM will use the action tool with proper parameters
    // For compound requests (e.g., "install nginx and configure firewall"), the LLM will execute sequentially
  } else {
    // Only check query intents if no action intent was detected
    // Check exposure intent first (most specific)
    const exposureIntent = detectExposureIntent(userInput);
    if (exposureIntent) {
      const exposureAnswer = await executeExposureIntent(exposureIntent, tools, session);
      if (exposureAnswer) {
        logger.info("Responding via twin-first exposure reasoning chain.");
        emitStepEvent({ intent: exposureIntent.type, mode: "twin_first", tool: "twin_query" });
        const traceId = await recordEarlyReturnTrace(exposureAnswer, exposureIntent.type, 1);
        emitFinalEvent(exposureAnswer, { intent: exposureIntent.type, traceId });
        return { text: exposureAnswer };
      }
    }

    // Skip compute intent if this is a diagnostic/troubleshooting request
    // Diagnostic requests should go to the LLM to use infrastructure_diagnostic tool
    const isDiagnosticRequest = 
      userInput.toLowerCase().includes("diagnose") ||
      userInput.toLowerCase().includes("why isn't") ||
      userInput.toLowerCase().includes("why is") ||
      userInput.toLowerCase().includes("check why") ||
      userInput.toLowerCase().includes("troubleshoot") ||
      userInput.toLowerCase().includes("what's wrong");

    // Skip compute intent if this is an IP address query (should go to LLM to use twin_query + proxmox_readonly)
    const isIpAddressQuery = 
      userInput.toLowerCase().includes("ip address") ||
      userInput.toLowerCase().includes("ip addresses") ||
      userInput.toLowerCase().includes("what is the ip") ||
      userInput.toLowerCase().includes("what are the ip");
    
    const computeIntent = detectComputeIntent(userInput);
    if (computeIntent && !isDiagnosticRequest && !isIpAddressQuery) {
      const twinAnswer = await executeComputeIntent(computeIntent, tools, session);
      if (twinAnswer) {
        logger.info("Responding via twin-first reasoning chain (no LLM needed).");
        emitStepEvent({ intent: computeIntent.type, mode: "twin_first", tool: "twin_query" });
        const traceId = await recordEarlyReturnTrace(twinAnswer, computeIntent.type, 1);
        emitFinalEvent(twinAnswer, { intent: computeIntent.type, traceId });
        return { text: twinAnswer };
      }
    }

    // Check firewall QUERY intent (only if no action intent detected)
    // Action intents like "configure firewall" are handled above
    const firewallIntent = detectFirewallIntent(userInput);
    if (firewallIntent) {
      const firewallAnswer = await executeFirewallIntent(firewallIntent, tools, session);
      if (firewallAnswer) {
        logger.info("Responding via twin-first firewall reasoning chain.");
        emitStepEvent({ intent: firewallIntent.type, mode: "twin_first", tool: "twin_query" });
        const traceId = await recordEarlyReturnTrace(firewallAnswer, firewallIntent.type, 1);
        emitFinalEvent(firewallAnswer, { intent: firewallIntent.type, traceId });
        return { text: firewallAnswer };
      }
    }
    // Only check network intent if no action, exposure, compute, or firewall intent was detected
    const networkIntent = detectNetworkIntent(userInput);
    if (networkIntent) {
      const networkAnswer = await executeNetworkIntent(networkIntent, tools, session);
      if (networkAnswer) {
        logger.info("Responding via twin-first network reasoning chain.");
        emitStepEvent({ intent: networkIntent.type, mode: "twin_first", tool: "twin_query" });
        const traceId = await recordEarlyReturnTrace(networkAnswer, networkIntent.type, 1);
        emitFinalEvent(networkAnswer, { intent: networkIntent.type, traceId });
        return { text: networkAnswer };
      }
    }
  }

  const openaiTools = buildToolDefinitions(tools);
  
  // Initialize reasoning trace
  const reasoningSteps: ReasoningStep[] = [];
  let totalToolCalls = 0;
  
  // Skip RAG for trivial queries (greetings, simple questions that don't need context)
  // Also skip RAG for action intents - they should go straight to the action tool
  // Also skip RAG for real-time metric queries (uptime, memory, cpu, etc.) - these need tools for accurate data
  // This significantly improves response time and prevents RAG from confusing action execution or providing stale data
  const isTrivialQuery = (query: string): boolean => {
    const normalized = query.toLowerCase().trim();
    const trivialPatterns = [
      /^(hi|hello|hey|greetings|good (morning|afternoon|evening))[!.]?$/i,
      /^(thanks?|thank you|thx)[!.]?$/i,
      /^(bye|goodbye|see you)[!.]?$/i,
      /^(yes|no|ok|okay|sure|yep|nope)[!.]?$/i,
      /^(help|what can you do|what do you do)[?]?$/i,
    ];
    return trivialPatterns.some(pattern => pattern.test(normalized));
  };
  
  // Detect real-time metric queries that should use tools, not RAG
  // These queries need current/live data that RAG can't provide accurately
  const realTimeMetricPatterns = [
    /\b(uptime|memory|ram|cpu|disk|load|temperature|temp|status)\s+(of|for)\s+/i,
    /\b(what|what's|what is)\s+(the\s+)?(uptime|memory|ram|cpu|disk|load|temperature|temp|status)\s+(of|for)\s+/i,
    /\b(how\s+much\s+)?(memory|ram|cpu|disk)\s+(does|has|is)\s+/i,
    /\b(how\s+long\s+)?(has|is)\s+.*\s+(been\s+)?(running|up)\b/i,
  ];
  
  const isRealTimeMetricQuery = realTimeMetricPatterns.some(pattern => pattern.test(userInput));
  
  // Skip RAG for action intents - they should use the action tool directly
  const shouldSkipRAG = isTrivialQuery(userInput) || !!actionIntent || isRealTimeMetricQuery;
  
  if (isRealTimeMetricQuery) {
    logger.info("Skipping RAG for real-time metric query - will use tools instead", {
      query: userInput.slice(0, 100),
    });
  }
  
  // Only fetch RAG context for non-trivial queries and non-action intents
  // Action intents should go straight to the action tool without RAG context
  // RAG context can confuse the LLM into thinking VMs don't exist when they do
  const ragPayload = shouldSkipRAG
    ? null 
    : await fetchHybridContext(userInput, {
        baseUrl: options.ragBaseUrl,
        userId: session.userId,
        aclGroup: session.aclGroup,
      });

  const ragMessage = ragPayload ? [{ role: "system", content: formatRagSummary(ragPayload) }] : [];
  
  // For real-time metric queries, add explicit instruction to use tools
  const realTimeMetricInstruction = isRealTimeMetricQuery 
    ? [{ role: "system", content: "IMPORTANT: This query asks for real-time metrics (uptime, memory, CPU, etc.). You MUST use tools (twin_query and/or proxmox_readonly) to get current data. Do not answer from memory or training data - always use tools for real-time metrics." }]
    : [];
  
  const MAX_STEPS = 5;
  const MAX_TOOL_CALLS_PER_STEP = 5; // Prevent tool call flooding (reduced from 10)
  const seenToolCalls = new Set<string>(); // Track tool calls to prevent infinite loops
  const client = getOpenAIClient();
  
  // Track if we've successfully retrieved data for real-time metric queries
  // Once we have the data, allow text responses instead of forcing more tool calls
  let hasRealTimeMetricData = false;
  
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

    // Build messages array with optional resolved VM context
    const vmContextMessage = resolvedVmContext ? [
      { role: "system", content: resolvedVmContext }
    ] : [];
    
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...ragMessage,
      ...realTimeMetricInstruction,
      ...vmContextMessage,
      ...context.getMessages(),
    ] as any[];

    const request: any = {
      model: "gpt-4o-mini",
      messages,
    };

    if (openaiTools.length > 0) {
      request.tools = openaiTools;
      // For real-time metric queries, force tool usage ONLY if we haven't gotten the data yet
      // Once we have the data (hasRealTimeMetricData), allow text responses
      request.tool_choice = (isRealTimeMetricQuery && !hasRealTimeMetricData) ? "required" : "auto";
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
          
          // For real-time metric queries, mark that we've successfully retrieved data
          if (isRealTimeMetricQuery && result.data && !result.error) {
            hasRealTimeMetricData = true;
            logger.info("Real-time metric data retrieved successfully (parallel path), allowing text response", {
              toolName,
              hasData: !!result.data,
            });
          }
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

        // CRITICAL: Add tool result to context IMMEDIATELY after execution
        // This ensures the context is always correct before any failure handling
        // that might add user messages and trigger another LLM call
        const sanitizedData = sanitizeToolPayload(result.data);
        context.addToolResult(toolCall.id, toolName, {
          provenanceId,
          success: !result.error,
          data: sanitizedData,
          error: result.error ?? null,
          durationMs: result.durationMs ?? 0,
        });

        if (result.error) {
          logger.error(`Tool execution failed: ${toolName}`, {
            error: result.error,
            parameters: parsedArgs,
          });
          
          // Reclassify intent with failure context instead of blindly retrying
          const failureHistory = failureTracker.getFailureHistory(userInput);
          const attemptNumber = failureHistory.length + 1;
          
          // Check if we should stop retrying
          if (failureTracker.shouldStopRetrying(userInput)) {
            logger.warn(`Stopping retries for "${userInput}" after ${attemptNumber} attempts`);
            reasoningStep.decisions.push({
              type: "failure_limit_reached",
              description: `Tool execution failed after ${attemptNumber} attempts. Stopping retries to prevent loop.`,
              metadata: { toolName, error: result.error, attemptNumber },
            });
          } else {
            // Record failure and reclassify with context
            const failureContext: FailureContext = {
              error: result.error,
              toolName,
              parameters: parsedArgs,
              partialState: result.data ? { partialData: result.data } : undefined,
              attemptNumber,
              previousAttempts: failureHistory.map(f => ({
                toolName: f.toolName,
                error: f.error,
                attemptNumber: f.attemptNumber,
              })),
            };
            
            failureTracker.recordFailure(userInput, failureContext);
            
            // Get original classification for confidence monotonicity
            const originalClassification = failureTracker.getOriginalClassification(userInput);
            
            // Reclassify with context (confidence will be capped to original if no new evidence)
            const reclassification = reclassifyIntentWithContext(
              userInput, 
              failureContext,
              originalClassification
            );
            
            logger.info(`Reclassified intent after failure`, {
              originalInput: userInput,
              originalConfidence: originalClassification?.confidence,
              newClassification: reclassification.classification.type,
              newConfidence: reclassification.classification.confidence,
              confidenceAdjusted: reclassification.confidenceAdjusted,
              shouldRetry: reclassification.shouldRetry,
              reason: reclassification.reason,
              suggestedAction: reclassification.suggestedAction,
            });
            
            reasoningStep.decisions.push({
              type: "failure_reclassification",
              description: reclassification.reason,
              metadata: {
                toolName,
                error: result.error,
                attemptNumber,
                originalConfidence: originalClassification?.confidence,
                newClassification: reclassification.classification.type,
                newConfidence: reclassification.classification.confidence,
                confidenceAdjusted: reclassification.confidenceAdjusted,
                shouldRetry: reclassification.shouldRetry,
                suggestedAction: reclassification.suggestedAction,
              },
            });
            
            // If reclassification suggests a different approach, add context to help LLM
            if (reclassification.shouldRetry && reclassification.suggestedAction) {
              context.addUserMessage(
                `Previous attempt failed: ${result.error}. ${reclassification.suggestedAction}`
              );
            } else if (!reclassification.shouldRetry) {
              // Don't retry - add context explaining why
              context.addUserMessage(
                `Tool execution failed: ${result.error}. ${reclassification.reason}. Please try a different approach or ask for clarification.`
              );
            }
          }
        } else {
          logger.debug(`Tool execution succeeded: ${toolName}`, {
            dataKeys: result.data && typeof result.data === 'object' ? Object.keys(result.data) : [],
          });
          
          // Clear failure history on success
          failureTracker.clearHistory(userInput);
          
          // For real-time metric queries, mark that we've successfully retrieved data
          // This allows the LLM to respond with text instead of forcing more tool calls
          if (isRealTimeMetricQuery && result.data && !result.error) {
            hasRealTimeMetricData = true;
            logger.info("Real-time metric data retrieved successfully, allowing text response", {
              toolName,
              hasData: !!result.data,
            });
          }
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
      
      // Record reasoning trace first to get trace ID
      let traceId: string | undefined;
      try {
        const traceStore = getReasoningTraceStore();
        traceId = await traceStore.recordTrace({
          userId: session.userId,
          aclGroup: session.aclGroup,
          userInput,
          finalResponse: finalText,
          steps: reasoningSteps,
          totalSteps: reasoningSteps.length,
          totalToolCalls,
          maxStepsReached: false,
          timestamp: new Date(),
          durationMs: Date.now() - startTime,
        });
      } catch (error: any) {
        logger.warn("Failed to record reasoning trace", { error: error.message });
      }
      
      // Emit agent:final event with trace ID
      const durationMs = Date.now() - startTime;
      emitFinalEvent(finalText, { totalSteps: step + 1, totalToolCalls, traceId });
      
      return { text: finalText };
    }
  }

  // Max steps reached - record trace
  const durationMs = Date.now() - startTime;
  let traceId: string | undefined;
  try {
    const traceStore = getReasoningTraceStore();
    traceId = await traceStore.recordTrace({
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
  
  emitFinalEvent("Max reasoning depth reached. Please try a simpler query.", { 
    totalSteps: reasoningSteps.length, 
    totalToolCalls,
    traceId 
  });

  return { text: "Max reasoning depth reached. Please try a simpler query." };
}

