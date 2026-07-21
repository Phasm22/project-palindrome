import readline from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { AgentResponse } from "../types/agent";
import type { ExecutionResult } from "../types/execution";
import { ConnectionTargetSchema, type ConnectionEndpoint } from "../types/connections";
import { buildConnectionEndpoints, resolveConnectionTarget, verifyConnectionEndpoints } from "../connections/verifier";
import type { ConversationContext, ConversationState, UserPreferences } from "../types";
import { logger } from "../utils/logger";
import { loadTools } from "./tool-loader";
import { executeToolCall } from "./tool-executor";
import { AgentContext } from "./context";
import { SYSTEM_PROMPT, buildSystemPrompt, buildStructuredResponsePrompt } from "./system-prompt";
import { generateObject } from "ai";
import { openai as aiSdkOpenai } from "@ai-sdk/openai";
import { fetchHybridContext, type HybridApiContext } from "./rag-client";
import { getToolRisk, isToolAuthorized, requiresConfirmation, type ToolSession } from "./tool-policy";
import { sanitizeToolPayload } from "./tool-sanitizer";
import {
  getReasoningTraceStore,
  type ReasoningStep,
  type ReasoningTraceArtifactInput,
  type ReasoningTraceProvenance,
} from "../pce/api/reasoning-trace-store";
import { AgentEventBus } from "./event-bus";
import { createTextAgentResponse } from "./schemas/agent-response";
import type { BaseTool } from "../tools/BaseTool";
import { detectComputeIntent, type ComputeIntent } from "../reasoning/compute-intents";
import {
  describeClusterChain,
  listAllVmsChain,
  listVmsByNodeChain,
  listRunningVmsOnNodeChain,
  listVmsWithoutAgentChain,
  listStoppedVmsChain,
  findVmByIdChain,
  findVmByNameChain,
  resolveVmDetailsChain,
  type ResolvedVmDetails,
} from "../reasoning/chains/compute";
import { detectNetworkIntent, type NetworkIntent } from "../reasoning/detectNetworkIntent";
import {
  describeNetworkChain,
  listNodeInterfacesChain,
  reachabilityChain,
  vmByIpFromIngestionChain,
  vmsBySubnetChain,
  vmsWithMultipleInterfacesFromIngestionChain,
  vmIpByNameChain,
  vmNetworksFromIngestionChain,
  vmReachabilityChain,
  switchVlansChain,
  switchPortsByVlanChain,
} from "../reasoning/chains/network";
import { detectFirewallIntent, type FirewallIntent } from "../reasoning/detectFirewallIntent";
import {
  listFirewallRulesChain,
  countFirewallRulesChain,
  aliasContentsChain,
  allowedPortsBetweenChain,
  firewallRulesByChainChain,
  sourcesAccessingNetworkChain,
  rulesAllowingSubnetChain,
  rulesBlockingSubnetChain,
  exposureMapChain,
  reachabilityFromSubnetChain,
  reachabilityFromChainChain,
  ruleImpactChain,
} from "../reasoning/chains/firewall";
import { detectExposureIntent, type ExposureIntent } from "../reasoning/detectExposureIntent";
import {
  analyzeVmExposureChain,
  listVmsExposedToSubnetChain,
  attackPathChain,
  listInternetExposedVmsChain,
} from "../reasoning/chains/exposure";
import { detectActionIntent, extractCreateVmParameters } from "../reasoning/action-intents";
import {
  buildApplicationManifest,
  parseCompoundApplicationRequest,
} from "./application-request";
import {
  loadKnownEntitiesFromIngestionSummary,
  loadKnownEntitiesFromProxmox,
} from "../reasoning/clarification";
import { classifyAndRouteWithLLM, classifyIntentWithLLM } from "../reasoning/intent-router";
import { isLikelyCompositeQuery } from "../reasoning/composite-query";
import { getRetrievalEligibility, TOOL_FIRST_DOMAINS } from "./retrieval-eligibility";
import { reclassifyIntentWithContext, FailureTracker, type FailureContext } from "../reasoning/failure-reclassification";
import { formatResponseForBot, detectResponseIntent, type FormatContext, type ResponseMode } from "./response-formatter";
import { planConversation } from "./conversation-orchestrator";
import { parseConfirmationInput } from "./dialog-policy";
import { resolveClarificationContinuationInput } from "./clarification-continuation";
import { deriveToolCallRisk, mapToolRiskToIntentRisk, maxRisk } from "./tool-risk";
import { pceLogger } from "../pce/utils/logger";
import { TerraformRunner } from "../actions/helpers/terraform-runner";
import { buildAgentState } from "./state";
import { getOperatorMemoryStore } from "../pce/api/operator-memory-store";
import { HistoricalScorer } from "./historical-scorer";
import { registerFeedbackObserver } from "./feedback-observer";
import {
  handleConfirmation,
  handleIdentityAndSocial,
  handleConfirmRequest,
  handleClarifyFromPlan,
  handleExecute,
  emitFinalEvent,
  emitStepEvent,
  parseToolArgs,
  buildPendingActionRecord,
  summarizeToolCall,
  inferMissingToolSlots,
  cleanupAfterProxmoxDestroy,
} from "./handlers";

let openaiClient: OpenAI | null = null;
const ASSISTANT_NAME = "Pally";
const PROMPT_HASH = createHash("sha256").update(SYSTEM_PROMPT).digest("hex");
const PROMPT_VERSION = process.env.PROMPT_VERSION ?? PROMPT_HASH.slice(0, 8);
const MODEL_ID = "gpt-4o-mini";
let cachedAgentVersion: string | null = null;

export function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

function resolveAgentVersion(): string {
  if (cachedAgentVersion) return cachedAgentVersion;
  const envVersion =
    process.env.AGENT_VERSION ||
    process.env.GIT_SHA ||
    process.env.COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA;
  if (envVersion) {
    cachedAgentVersion = envVersion;
    return envVersion;
  }
  try {
    const bun = (globalThis as any).Bun;
    if (bun?.spawnSync) {
      const result = bun.spawnSync({
        cmd: ["git", "rev-parse", "HEAD"],
        cwd: process.cwd(),
      });
      const stdout = result?.stdout?.toString?.().trim();
      if (stdout) {
        cachedAgentVersion = stdout;
        return stdout;
      }
    }
  } catch (error) {
    // Ignore and fall back to unknown
  }
  cachedAgentVersion = "unknown";
  return cachedAgentVersion;
}

function computeToolRegistryVersion(tools: BaseTool[]): string {
  const toolDigest = tools
    .map((tool) => ({
      name: tool.metadata.name,
      description: tool.metadata.description ?? "",
      parameters: tool.metadata.parameters ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(toolDigest)).digest("hex");
}

export function buildProvenance(params: {
  toolRegistryVersion?: string;
  policyMode?: string;
  selectedMode?: ResponseMode;
}): ReasoningTraceProvenance {
  return {
    agentVersion: resolveAgentVersion(),
    promptVersion: PROMPT_VERSION,
    promptHash: PROMPT_HASH,
    modelId: MODEL_ID,
    toolRegistryVersion: params.toolRegistryVersion ?? "unknown",
    policyMode: params.policyMode ?? "standard",
    selectedMode: params.selectedMode,
  };
}

function normalizeUserName(rawName: string): string {
  const trimmed = rawName.trim().replace(/[.!?]+$/, "");
  const collapsed = trimmed.replace(/\s+/g, " ");
  if (!collapsed) return "";
  const unquoted = collapsed.replace(/^["'](.+)["']$/, "$1");
  const isAllLower = unquoted === unquoted.toLowerCase();
  const isAllUpper = unquoted === unquoted.toUpperCase();
  if (isAllLower || isAllUpper) {
    return unquoted
      .split(" ")
      .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part))
      .join(" ");
  }
  return unquoted;
}

function extractUserNameUpdate(input: string): string | null {
  const patterns = [
    /^\s*my name is\s+(.+)\s*$/i,
    /^\s*call me\s+(.+)\s*$/i,
    /^\s*you can call me\s+(.+)\s*$/i,
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (!match) continue;
    const candidate = normalizeUserName(match[1] ?? "");
    if (!candidate || candidate.length > 60) return null;
    const lower = candidate.toLowerCase();
    const stopPhrases = [" and ", " but ", " also ", " plus ", " because ", " then ", " please "];
    if (stopPhrases.some((phrase) => lower.includes(phrase))) {
      return null;
    }
    return candidate;
  }
  return null;
}

function isUserNameQuery(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return (
    /^(what('?s| is) my name)\??$/.test(normalized) ||
    /^(do you know my name)\??$/.test(normalized) ||
    /^(tell me my name)\??$/.test(normalized)
  );
}

function isAssistantNameQuery(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return (
    /^(what('?s| is) your name)\??$/.test(normalized) ||
    /^(who are you)\??$/.test(normalized)
  );
}

function isMetaIdentityQuery(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  if (isUserNameQuery(normalized) || isAssistantNameQuery(normalized)) return true;
  return /^(what do you do|what can you do)\??$/.test(normalized);
}

export const RETRIEVAL_MIN_SCORE = 0.35;

/** Injected when the query is composite so the LLM uses multiple tool calls and synthesizes. */
export const COMPOSITE_MULTI_STEP_INSTRUCTION =
  "The user's question has multiple parts (e.g. list items in a scope AND a property like exposure level). You MUST use multiple tool calls to satisfy each part (e.g. first list VMs in the subnet, then get exposure/level for those VMs), then synthesize one answer. Do not answer from only one tool if the question asks for multiple dimensions.";

export function hasDomainMatch(domain: string | undefined, rag: HybridApiContext): boolean {
  if (!domain || domain === "general") return true;
  const paths: string[] = [];
  if (rag.sources) {
    paths.push(...rag.sources.map((source) => source.sourcePath || ""));
  }
  const keywords: Record<string, string[]> = {
    compute: ["proxmox", "vm", "lxc", "cluster", "compute"],
    network: ["network", "subnet", "interface", "vlan"],
    firewall: ["firewall", "opnsense", "rules"],
    metrics: ["metrics", "temperature", "sensors", "cpu", "memory"],
  };
  const tokens = keywords[domain] ?? [];
  if (tokens.length === 0) return true;
  const haystack = paths.join(" ").toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

export function buildRetrievalArtifacts(rag: HybridApiContext): {
  artifacts: ReasoningTraceArtifactInput[];
  ragContextId?: string;
  graphContextId?: string;
  fusionContextId?: string;
} {
  const artifacts: ReasoningTraceArtifactInput[] = [];
  const ragContextId = randomUUID();
  const topChunks = rag.context?.semanticChunks?.slice(0, 3) ?? [];
  artifacts.push({
    id: ragContextId,
    kind: "rag_context",
    payload: {
      queryType: rag.queryType,
      sTotalScore: rag.sTotalScore ?? null,
      sourcesCount: rag.sources?.length ?? 0,
      topChunks: topChunks.map((chunk) => ({
        sourcePath: chunk.sourcePath || "unknown",
        score: chunk.score ?? 0,
        chunkId: chunk.id ?? undefined,
      })),
      structuralPaths: rag.context?.structuralPaths?.length ?? 0,
    },
  });

  let graphContextId: string | undefined;
  if ((rag.fusionMetrics?.graphResults ?? 0) > 0 || (rag.context?.structuralPaths?.length ?? 0) > 0) {
    graphContextId = randomUUID();
    artifacts.push({
      id: graphContextId,
      kind: "graph_context",
      payload: {
        queryType: rag.queryType,
        graphResults: rag.fusionMetrics?.graphResults ?? 0,
        structuralPaths: rag.context?.structuralPaths?.length ?? 0,
      },
    });
  }

  let fusionContextId: string | undefined;
  if (rag.fusionMetrics) {
    fusionContextId = randomUUID();
    artifacts.push({
      id: fusionContextId,
      kind: "fusion_context",
      payload: {
        vectorResults: rag.fusionMetrics.vectorResults,
        graphResults: rag.fusionMetrics.graphResults,
        fusedResults: rag.fusionMetrics.fusedResults,
        prunedResults: rag.fusionMetrics.prunedResults,
        avgTotalScore: rag.fusionMetrics.avgTotalScore,
      },
    });
  }

  return { artifacts, ragContextId, graphContextId, fusionContextId };
}

export function buildRetrievalToolCalls(rag: HybridApiContext): ReasoningStep["toolCalls"] {
  const calls: ReasoningStep["toolCalls"] = [];
  const ragSummary = {
    queryType: rag.queryType,
    sTotalScore: rag.sTotalScore ?? null,
    sourcesCount: rag.sources?.length ?? 0,
  };
  const ragPreview = JSON.stringify(ragSummary);
  calls.push({
    toolName: "rag.retrieve",
    parameters: { queryType: rag.queryType },
    result: {
      success: true,
      dataPreview: ragPreview,
      dataSize: ragPreview.length,
      resultType: "summary",
    },
  });

  if (rag.queryType !== "SEMANTIC_ONLY") {
    const graphSummary = { graphResults: rag.fusionMetrics?.graphResults ?? 0 };
    const graphPreview = JSON.stringify(graphSummary);
    calls.push({
      toolName: "graph.query",
      parameters: { queryType: rag.queryType },
      result: {
        success: true,
        dataPreview: graphPreview,
        dataSize: graphPreview.length,
        resultType: "summary",
      },
    });
  }

  if (rag.fusionMetrics) {
    const fusionSummary = {
      fusedResults: rag.fusionMetrics.fusedResults,
      prunedResults: rag.fusionMetrics.prunedResults,
    };
    const fusionPreview = JSON.stringify(fusionSummary);
    calls.push({
      toolName: "fusion.rank",
      parameters: { queryType: rag.queryType },
      result: {
        success: true,
        dataPreview: fusionPreview,
        dataSize: fusionPreview.length,
        resultType: "summary",
      },
    });
  }
  return calls;
}

export function buildConversationMemoryPrompt(context?: ConversationContext): string | null {
  if (!context) return null;
  const lines: string[] = [];

  // Session context
  if (context.userName) lines.push(`user: ${context.userName}`);
  if (context.activeHost) lines.push(`active_host: ${context.activeHost}`);
  if (context.activeService) lines.push(`active_service: ${context.activeService}`);
  if (context.lastIncidentSignature) lines.push(`last_incident: ${context.lastIncidentSignature}`);

  // Pending action (human-readable fields only — skip id/digest/timestamps/raw payload)
  if (context.pendingActionType) lines.push(`pending_action_type: ${context.pendingActionType}`);
  if (context.pendingActionSummary) lines.push(`pending_action_summary: ${context.pendingActionSummary}`);
  if (context.pendingActionPreview) lines.push(`pending_action_preview: ${context.pendingActionPreview}`);

  if (lines.length === 0) return null;
  return `Conversation memory (chat scope only):\n${lines.map(l => `  ${l}`).join("\n")}`;
}

export function buildToolDefinitions(tools: ReturnType<typeof loadTools>) {
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

/** Exported for tests (synthesis exploration). */
export function formatRagSummary(rag: HybridApiContext) {
  const lines: string[] = [];
  lines.push(
    "The following CandidateAnswer was generated from retrieved context. Use it when it answers the user's question; if you also call tools, combine it with tool results in your final answer."
  );
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
      case "list_all_vms":
        return await listAllVmsChain(tools, session, intent.vmKind);
      case "vms_by_node":
        return await listVmsByNodeChain(tools, session, intent.nodeName, intent.vmKind);
      case "running_vms_on_node":
        return await listRunningVmsOnNodeChain(tools, session, intent.nodeName, intent.vmKind);
      case "vms_without_agent":
        return await listVmsWithoutAgentChain(tools, session);
      case "stopped_vms_on_node":
        return await listStoppedVmsChain(tools, session, intent.nodeName, intent.vmKind);
      case "find_vm_by_id":
        return await findVmByIdChain(tools, session, intent.vmId);
      case "find_vm_by_name":
        return await findVmByNameChain(tools, session, intent.vmName, intent.vmKind);
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
      case "vm_reachability":
        return await vmReachabilityChain(intent.vmId, tools, session);
      case "vm_networks":
        return await vmNetworksFromIngestionChain(intent.vmNameOrId);
      case "vm_by_ip":
        return await vmByIpFromIngestionChain(intent.ip);
      case "vm_ip_by_name":
        return await vmIpByNameChain(intent.vmNameOrId, tools, session);
      case "vms_with_multiple_interfaces":
        return await vmsWithMultipleInterfacesFromIngestionChain();
      case "switch_vlans":
        return await switchVlansChain(tools, session);
      case "switch_ports_by_vlan":
        return await switchPortsByVlanChain(tools, session, intent.vlan);
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
      case "vm_reachability":
        return await reachabilityFromSubnetChain(intent.subnetCidr, intent.vmId, tools, session);
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
      case "count_rules":
        return await countFirewallRulesChain(intent.direction, tools, session);
      case "alias_contents":
        return await aliasContentsChain(intent.aliasName, tools, session);
      case "allowed_ports_between":
        return await allowedPortsBetweenChain(intent.from, intent.to, tools, session);
      case "rules_by_chain":
        return await firewallRulesByChainChain(intent.chain, tools, session);
      case "sources_accessing_network":
        return await sourcesAccessingNetworkChain(intent.chain, intent.target, tools, session);
      case "rules_allowing_subnet":
        return await rulesAllowingSubnetChain(intent.subnet, tools, session);
      case "rules_blocking_subnet":
        return await rulesBlockingSubnetChain(intent.subnet, tools, session);
      case "exposure_map":
        return await exposureMapChain(intent.vmId, tools, session);
      case "reachability_from_chain":
        return await reachabilityFromChainChain(intent.chain, tools, session);
      case "rule_impact":
        return await ruleImpactChain(intent.ruleId, tools, session);
      default:
        return null;
    }
  } catch (error: any) {
    logger.error(`Firewall reasoning chain failed: ${error.message}`);
    return null;
  }
}

function buildFirewallToolCalls(intent: FirewallIntent): Array<{ toolName: string; parameters: Record<string, any> }> {
  switch (intent.type) {
    case "list_rules":
      return [{ toolName: "twin_query", parameters: { operation: "firewall_list_rules" } }];
    case "count_rules":
      return [{ toolName: "twin_query", parameters: { operation: "firewall_list_rules" } }];
    case "alias_contents":
      return [{ toolName: "opnsense_readonly", parameters: { action: "firewall_aliases_get", alias_name: intent.aliasName } }];
    case "allowed_ports_between":
      return [
        { toolName: "opnsense_readonly", parameters: { action: "firewall_rules_list" } },
        { toolName: "opnsense_readonly", parameters: { action: "firewall_aliases_list" } },
      ];
    case "rules_by_chain":
      return [{ toolName: "twin_query", parameters: { operation: "firewall_rules_by_chain", params: { chain: intent.chain } } }];
    case "sources_accessing_network":
      return [{ toolName: "twin_query", parameters: { operation: "firewall_rules_by_chain", params: { chain: intent.chain } } }];
    case "rules_allowing_subnet":
      return [{ toolName: "twin_query", parameters: { operation: "firewall_rules_allowing_subnet", params: { subnet: intent.subnet } } }];
    case "rules_blocking_subnet":
      return [{ toolName: "twin_query", parameters: { operation: "firewall_rules_blocking_subnet", params: { subnet: intent.subnet } } }];
    case "exposure_map":
      return [{
        toolName: "twin_query",
        parameters: intent.vmId
          ? { operation: "firewall_exposure_map", params: { vmId: intent.vmId } }
          : { operation: "firewall_exposure_map" },
      }];
    case "reachability_from_chain":
      return [{ toolName: "twin_query", parameters: { operation: "firewall_reachability_from_chain", params: { chain: intent.chain } } }];
    case "rule_impact":
      return [{ toolName: "twin_query", parameters: { operation: "firewall_rule_impact", params: { ruleId: intent.ruleId } } }];
    default:
      return [{ toolName: "twin_query", parameters: { operation: "firewall_list_rules" } }];
  }
}

export type AgentRunOptions = {
  stream?: boolean;
  userId?: string;
  aclGroup?: string;
  confirmHighRisk?: (info: { toolName: string; parameters: Record<string, any>; risk: string }) => Promise<boolean>;
  ragBaseUrl?: string;
  sessionId?: string; // Optional session ID for event tracking
  conversationId?: string;
  conversationState?: ConversationState;
  conversationContext?: ConversationContext;
  userPreferences?: UserPreferences;
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>; // Previous messages in conversation
  /** Cooperatively stops the run. In-flight tools finish before the run becomes idle. */
  signal?: AbortSignal;
  /** When set (e.g. by PCE API), used to inject profile public key into create_vm params for dashboard users */
  getProfilePublicKey?: (userId: string) => string | null;
  /** When set (e.g. by PCE API), used to inject profile SSH username into create_vm params for dashboard users */
  getProfileSshUsername?: (userId: string) => string | null;
};

export function coerceTextContent(content: any): string {
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

  options.signal?.throwIfAborted();

  if (options.stream) {
    logger.warn("Streaming mode is not available with tool orchestration; defaulting to non-streaming mode.");
  }

  logger.info(`Agent received input: "${userInput}"`);

  const startTime = Date.now();
  // Generate session ID if not provided
  const sessionId = options.sessionId ?? `session-${startTime}-${Math.random().toString(36).slice(2, 9)}`;
  const eventBus = AgentEventBus.getInstance();

  const originalUserInput = userInput;
  let confirmation = parseConfirmationInput(userInput);
  const pendingAction = options.conversationContext?.pendingAction;
  const pendingActionId = options.conversationContext?.pendingActionId;
  const pendingActionExecuteInput = options.conversationContext?.pendingActionExecuteInput ?? pendingAction;
  const pendingActionPreview =
    options.conversationContext?.pendingActionPreview ??
    options.conversationContext?.pendingActionSummary ??
    pendingAction;
  const pendingActionCreatedAt = options.conversationContext?.pendingActionCreatedAt;
  const pendingActionExpiresAt = options.conversationContext?.pendingActionExpiresAt;
  const pendingActionSummary =
    options.conversationContext?.pendingActionSummary ??
    options.conversationContext?.pendingActionPreview ??
    pendingAction;
  const pendingActionExpired =
    typeof pendingActionExpiresAt === "number"
      ? Date.now() > pendingActionExpiresAt
      : (pendingActionCreatedAt ? (Date.now() - pendingActionCreatedAt) > (15 * 60 * 1000) : false);
  let usedPendingAction = false;

  /** Record a minimal reasoning trace for router/handler early-returns so observability matches PCE logs. */
  const recordRouterTrace = async (
    userInput: string,
    finalResponse: string,
    handler: string,
    decision: string,
    sessionLike: { userId: string; aclGroup: string }
  ) => {
    try {
      const traceStore = getReasoningTraceStore();
      await traceStore.recordTrace({
        userId: sessionLike.userId,
        aclGroup: sessionLike.aclGroup,
        userInput,
        finalResponse,
        steps: [{
          step: 1,
          toolCalls: [],
          decisions: [{
            type: "conversation_path",
            description: `Router: ${handler} (decision=${decision}). Response returned without EXECUTE.`,
            metadata: { handler, decision, router: "runAgent" },
          }],
        }],
        totalSteps: 1,
        totalToolCalls: 0,
        maxStepsReached: false,
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
      });
    } catch (error: any) {
      logger.warn("Failed to record router trace", { error: error.message, handler, decision });
    }
  };

  const confirmResult = handleConfirmation({
    confirmation,
    userInput,
    pendingActionId,
    pendingActionExecuteInput,
    pendingAction,
    pendingActionPreview,
    pendingActionSummary,
    pendingActionCreatedAt,
    pendingActionExpiresAt,
    pendingActionExpired,
    conversationContext: options.conversationContext,
    eventBus,
    sessionId,
    startTime,
  });
  if (confirmResult.handled) {
    await recordRouterTrace(originalUserInput, confirmResult.response.text, "handleConfirmation", "CONFIRM_HANDLED", {
      userId: options.userId ?? "agent-user",
      aclGroup: options.aclGroup ?? "admin",
    });
    return confirmResult.response;
  }
  userInput = confirmResult.effectiveInput;
  usedPendingAction = confirmResult.usedPendingAction;

  const clarificationContinuation = resolveClarificationContinuationInput({
    userInput,
    conversationState: options.conversationState,
    conversationHistory: options.conversationHistory,
  });
  if (clarificationContinuation.usedContinuation) {
    userInput = clarificationContinuation.effectiveInput;
  }

  const session: ToolSession = {
    userId: options.userId ?? "agent-user",
    aclGroup: options.aclGroup ?? "admin",
  };

  const operatorMemoryStore = getOperatorMemoryStore();
  const historicalScorer = new HistoricalScorer(operatorMemoryStore);

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
  const toolRegistryVersion = computeToolRegistryVersion(tools);
  
  // Track failures to prevent retry loops (must be declared before classification)
  const failureTracker = new FailureTracker();

  // Helper to record reasoning trace for early returns
  const recordEarlyReturnTrace = async (
    answer: string,
    intent: string,
    toolCalls: number = 1,
    toolCallDetails?: Array<{ toolName: string; parameters?: Record<string, any> }>
  ): Promise<string | undefined> => {
    const durationMs = Date.now() - startTime;
    try {
      const stepToolCalls = (toolCallDetails && toolCallDetails.length > 0
        ? toolCallDetails
        : [{ toolName: "twin_query", parameters: { intent } }]).map((toolCall) => ({
          toolName: toolCall.toolName,
          parameters: toolCall.parameters ?? {},
          result: { success: true },
          durationMs,
        }));

      const traceStore = getReasoningTraceStore();
      const traceId = await traceStore.recordTrace({
        userId: session.userId,
        aclGroup: session.aclGroup,
        userInput,
        finalResponse: answer,
        steps: [{
          step: 1,
          toolCalls: stepToolCalls,
          decisions: [{
            type: "tool_choice",
            description: `Used twin-first reasoning chain for ${intent}`,
            metadata: { intent, mode: "twin_first" },
          }],
        }],
        provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: state.responseMode }),
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

  const buildBotMoveContext = async (observations: string, intentLabel: string): Promise<string> => {
    if (!observations || observations.trim().length < 40) {
      return "";
    }

    const cappedObservations = observations
      .split("\n")
      .slice(0, 20)
      .join("\n")
      .slice(0, 2000);

    const parts: string[] = [];

    try {
      const summaryResult = await executeToolCall(
        {
          toolName: "summarize_observations",
          parameters: { observations: cappedObservations, intent: intentLabel },
        },
        tools,
        { userId: session.userId, aclGroup: session.aclGroup }
      );
      const summaryText = (summaryResult as any)?.data?.summary;
      if (typeof summaryText === "string" && summaryText.trim().length > 0) {
        parts.push(`Evidence:\n${summaryText.trim()}`);
      }
    } catch (error: any) {
      logger.warn("summarize_observations failed", { error: error.message });
    }

    try {
      const nextStepsResult = await executeToolCall(
        {
          toolName: "next_steps",
          parameters: { intent: intentLabel, observations: cappedObservations },
        },
        tools,
        { userId: session.userId, aclGroup: session.aclGroup }
      );
      const steps = (nextStepsResult as any)?.data?.steps;
      if (Array.isArray(steps) && steps.length > 0) {
        const formattedSteps = steps.map((step: string) => `- ${step}`).join("\n");
        parts.push(`Next steps:\n${formattedSteps}`);
      }
    } catch (error: any) {
      logger.warn("next_steps failed", { error: error.message });
    }

    return parts.join("\n\n");
  };

  const formatStructuredFieldValue = (value: unknown): string => {
    return String(value ?? "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\|/g, "/")
      .trim();
  };

  // ============================================================
  // CLARIFICATION CHECK - detect typos and ambiguous queries
  // ============================================================
  
  // Lazily load known entities from Proxmox (first run only)
  await loadKnownEntitiesFromIngestionSummary();
  await loadKnownEntitiesFromProxmox(async (toolName, params) => {
    const tool = tools.find(t => t.metadata.name === toolName);
    if (!tool) return null;
    return tool.execute(params, { toolName, startedAt: Date.now() });
  });
  
  // Classify intent using LLM (generateObject); falls back to regex classifier on API failure
  const { classification, routing } = await classifyAndRouteWithLLM(userInput);
  const compoundApplicationRequest = parseCompoundApplicationRequest(userInput);
  if (compoundApplicationRequest && !compoundApplicationRequest.node) {
    classification.missing = Array.from(new Set([...classification.missing, "environment"]));
  }
  const isCompositeQuery = isLikelyCompositeQuery(userInput, classification);
  const actionName = classification.metadata?.actionType as string | undefined;
  const historicalScore = historicalScorer.getScore(session.userId, classification.intent, actionName);
  registerFeedbackObserver(eventBus, operatorMemoryStore, session.userId, session.aclGroup, classification.intent, actionName);
  const conversationPlan = planConversation({
    userInput,
    intent: classification,
    routing,
    conversationState: options.conversationState,
    conversationContext: options.conversationContext,
    userPreferences: options.userPreferences,
    confirmation,
    score: historicalScore,
    scorer: historicalScorer,
  });
  const responseMode: ResponseMode | undefined = conversationPlan.responseMode;
  const contextUpdate: ConversationContext = {};
  if (classification.entities.hosts.length > 0) {
    contextUpdate.activeHost = classification.entities.hosts[0];
  }
  if (classification.entities.services.length > 0) {
    contextUpdate.activeService = classification.entities.services[0];
  }
  const postExecutionState: ConversationState = conversationPlan.shouldExecute ? "FOLLOWUP" : conversationPlan.nextState;
  const finalContextUpdate: ConversationContext = { ...contextUpdate };
  const shouldClearPending =
    usedPendingAction ||
    (confirmation.confirmed && conversationPlan.shouldExecute);
  if (shouldClearPending) {
    finalContextUpdate.pendingAction = "";
    finalContextUpdate.pendingActionId = "";
    finalContextUpdate.pendingActionDigest = "";
    finalContextUpdate.pendingActionCreatedAt = 0;
    finalContextUpdate.pendingActionSummary = "";
    finalContextUpdate.pendingActionType = "";
    finalContextUpdate.pendingActionPreview = "";
    finalContextUpdate.pendingActionExecuteInput = "";
    finalContextUpdate.pendingActionExpiresAt = 0;
  }
  const state = buildAgentState({
    originalUserInput,
    effectiveUserInput: userInput,
    sessionId,
    startTime,
    session,
    options,
    classification,
    routing,
    conversationPlan,
    confirmation,
    clarificationContinuation,
    tools,
    contextUpdate,
    finalContextUpdate,
    postExecutionState,
    responseMode,
  });
  
  // Store original classification for confidence monotonicity
  failureTracker.setOriginalClassification(state.effectiveUserInput, state.classification);
  
  logger.info("Intent classification", {
    input: state.effectiveUserInput.slice(0, 100),
    type: state.classification.type,
    confidence: state.classification.confidence,
    metadata: state.classification.metadata,
    route: state.routing.route,
    clarification_continuation: state.clarificationContinuation.usedContinuation,
    clarification_anchor: state.clarificationContinuation.anchorUserInput,
  });
  logger.info("Conversation transition", {
    conversation_state_before: options.conversationState ?? "IDLE",
    decision: state.conversationPlan.decision,
    confirmation_id: pendingActionId ?? null,
    pending_action_source: usedPendingAction ? "pending_replay" : "user_input",
  });

  const policyMode = options.userPreferences?.safeMode ? "safe" : "standard";
  const memoryUserName = options.conversationContext?.userName;
  const identityResult = await handleIdentityAndSocial({
    state,
    memoryUserName,
    eventBus,
    assistantName: ASSISTANT_NAME,
    recordIdentityTrace: async ({ finalResponse, reason }) => {
      const traceStore = getReasoningTraceStore();
      try {
        return await traceStore.recordTrace({
          userId: session.userId,
          aclGroup: session.aclGroup,
          userInput,
          finalResponse,
          steps: [{
            step: 1,
            toolCalls: [],
            decisions: [{
              type: "retrieval_skipped",
              description: `Retrieval skipped for ${reason}.`,
              metadata: { reason },
            }],
          }],
          provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: state.responseMode }),
          totalSteps: 1,
          totalToolCalls: 0,
          maxStepsReached: false,
          timestamp: new Date(),
          durationMs: Date.now() - startTime,
        });
      } catch (error: any) {
        logger.warn("Failed to record identity trace", { error: error.message });
        return undefined;
      }
    },
  });
  if (identityResult.handled) return identityResult.response;

  // Handle high-risk confirmation gate (bound to pending action)
  if (state.conversationPlan.decision === "ASK_CONFIRM") {
    const confirmRequestResult = handleConfirmRequest({
      state,
      conversationStateBefore: options.conversationState ?? "IDLE",
      eventBus,
    });
    await recordRouterTrace(originalUserInput, confirmRequestResult.text, "handleConfirmRequest", "ASK_CONFIRM", {
      userId: session.userId,
      aclGroup: session.aclGroup,
    });
    return confirmRequestResult;
  }

  // Handle clarification flow
  if (state.conversationPlan.decision === "ASK_CLARIFY") {
    const canHandleDirectly =
      detectFirewallIntent(userInput) !== null ||
      detectNetworkIntent(userInput) !== null ||
      detectComputeIntent(userInput) !== null ||
      detectExposureIntent(userInput) !== null;

    if (canHandleDirectly) {
      logger.info("ASK_CLARIFY bypassed: domain intent detector matched", { userInput: userInput.slice(0, 80) });
      // Fall through to domain-intent handlers below
    } else {
      const clarifyResult = await handleClarifyFromPlan({
        state,
        execContext: { userId: session.userId, aclGroup: session.aclGroup },
        eventBus,
      });
      await recordRouterTrace(originalUserInput, clarifyResult.text, "handleClarifyFromPlan", "ASK_CLARIFY", {
        userId: session.userId,
        aclGroup: session.aclGroup,
      });
      return clarifyResult;
    }
  }

  // Handle clarification requests (low confidence or genuinely ambiguous)
  // BUT: If we have domain metadata, try RAG first - it might have the answer
  // EXCEPT: Skip RAG for real-time metric queries (uptime, memory, cpu, etc.) - these need tools
  if (state.routing.route === "clarification") {
    // Short-circuit: if a domain-specific intent detector can handle this query directly,
    // skip clarification entirely and fall through to the direct-handler section below.
    // This catches queries like "can port 22 come into the lab from home" which score low
    // on the semantic ACTION classifier but are clearly firewall reachability questions.
    const canHandleDirectlyFromRoute =
      detectFirewallIntent(userInput) !== null ||
      detectNetworkIntent(userInput) !== null ||
      detectComputeIntent(userInput) !== null ||
      detectExposureIntent(userInput) !== null;
    if (canHandleDirectlyFromRoute) {
      logger.info("routing.clarification bypassed: domain intent detector matched", {
        userInput: userInput.slice(0, 80),
      });
      // Fall through to domain-intent handlers below
    } else {

    logger.info("Input needs clarification", {
      confidence: state.classification.confidence,
      type: state.classification.type,
      metadata: state.classification.metadata,
    });
    
    // Detect real-time metric queries that should use tools, not RAG
    const realTimeMetricPatterns = [
      /\b(uptime|memory|ram|cpu|disk|load|temperature|temp|status)\s+(of|for)\s+/i,
      /\b(what|what's|what is)\s+(the\s+)?(uptime|memory|ram|cpu|disk|load|temperature|temp|status)\s+(of|for)\s+/i,
      /\b(how\s+much\s+)?(memory|ram|cpu|disk)\s+(does|has|is)\s+/i,
      /\b(how\s+long\s+)?(has|is)\s+.*\s+(been\s+)?(running|up)\b/i,
      /\b(how\s+many\s+).*\b(uptime|running|up)\b/i,
      /\b(uptime|running)\s+(higher|greater|more|over|>\s*)\s*(\d+)\s*(days?|hours?)/i,
      /\b(uptime\s+>\s*\d+|\d+\s*\+\s*days?\s+uptime)/i,
    ];
    const isRealTimeMetricQuery = realTimeMetricPatterns.some(pattern => pattern.test(userInput));
    
    const clarificationRetrievalDecisions: ReasoningStep["decisions"] = [];
    const clarificationRetrievalToolCalls: ReasoningStep["toolCalls"] = [];
    const clarificationRetrievalArtifacts: ReasoningTraceArtifactInput[] = [];
    let clarificationRagContextId: string | undefined;
    let clarificationGraphContextId: string | undefined;
    let clarificationFusionContextId: string | undefined;

    // If we have domain metadata, try RAG first - the data might answer the question
    // BUT: Skip RAG for real-time metric queries and for tool-first domains
    const isToolFirstDomain = state.classification.metadata?.domain && (TOOL_FIRST_DOMAINS as readonly string[]).includes(state.classification.metadata.domain);
    if (state.classification.metadata?.domain && state.classification.confidence >= 0.2 && !isRealTimeMetricQuery && !isToolFirstDomain) {
      logger.info("Low confidence but domain detected - trying RAG before clarification", {
        domain: state.classification.metadata.domain,
        confidence: state.classification.confidence,
      });
      
      // Fetch RAG to see if we can answer from collected data
      const ragPayload = await fetchHybridContext(userInput, {
        baseUrl: options.ragBaseUrl,
        userId: session.userId,
        aclGroup: session.aclGroup,
      });
      if (ragPayload) {
        const ragScore = ragPayload.sTotalScore ?? null;
        const domainMatch = hasDomainMatch(state.classification.metadata?.domain, ragPayload);
        const hasSources = (ragPayload.sources?.length ?? 0) > 0;
        const injected =
          hasSources &&
          ragScore !== null &&
          ragScore >= RETRIEVAL_MIN_SCORE &&
          domainMatch;
        let injectedReason = "accepted";
        if (!hasSources) injectedReason = "no_sources";
        else if (ragScore === null || ragScore < RETRIEVAL_MIN_SCORE) injectedReason = "score_below_threshold";
        else if (!domainMatch) injectedReason = "domain_mismatch";

        clarificationRetrievalDecisions.push({
          type: "retrieval_executed",
          description: "Retrieval executed for low-confidence query.",
          metadata: {
            queryType: ragPayload.queryType,
            score: ragScore,
            sourcesCount: ragPayload.sources?.length ?? 0,
          },
        });
        clarificationRetrievalDecisions.push({
          type: injected ? "retrieval_injected" : "retrieval_not_injected",
          description: injected
            ? "Retrieval injected into prompt."
            : "Retrieval executed but not injected into prompt.",
          metadata: {
            score: ragScore,
            minScore: RETRIEVAL_MIN_SCORE,
            domainMatch,
            sourcesCount: ragPayload.sources?.length ?? 0,
            reason: injectedReason,
          },
        });

        const artifactBundle = buildRetrievalArtifacts(ragPayload);
        clarificationRetrievalArtifacts.push(...artifactBundle.artifacts);
        clarificationRagContextId = artifactBundle.ragContextId;
        clarificationGraphContextId = artifactBundle.graphContextId;
        clarificationFusionContextId = artifactBundle.fusionContextId;
        clarificationRetrievalToolCalls.push(...buildRetrievalToolCalls(ragPayload));

        // If RAG has a good answer (high score), use it instead of asking for clarification
        if (injected && ragPayload.answer) {
          logger.info("RAG provided answer despite low classification confidence", {
            sTotalScore: ragPayload.sTotalScore,
            answerLength: ragPayload.answer.length,
          });
          
          // Clean up the RAG answer (remove verbose citations, formatting)
          let cleanedAnswer = cleanupRagAnswer(ragPayload.answer);
          
          // Format response for bot-like style
          try {
            const intentType = detectResponseIntent(userInput);
            cleanedAnswer = await formatResponseForBot(cleanedAnswer, {
              userQuery: userInput,
              intentType,
              mode: state.responseMode,
            });
          } catch (error: any) {
            logger.warn("Failed to format RAG answer", { error: error.message });
          }
          
          // Record trace
          let traceId: string | undefined;
          try {
            const traceStore = getReasoningTraceStore();
            traceId = await traceStore.recordTrace({
              userId: session.userId,
              aclGroup: session.aclGroup,
              userInput,
              finalResponse: cleanedAnswer,
              steps: [{
                step: 1,
                toolCalls: clarificationRetrievalToolCalls,
                ragContextId: clarificationRagContextId,
                graphContextId: clarificationGraphContextId,
                fusionContextId: clarificationFusionContextId,
                decisions: [
                  ...clarificationRetrievalDecisions,
                  {
                    type: "rag_used",
                    description: `Low confidence (${state.classification.confidence.toFixed(2)}) but RAG provided answer (score: ${ragPayload.sTotalScore?.toFixed(2)})`,
                    metadata: { classification: state.classification, routing: state.routing, ragScore: ragPayload.sTotalScore },
                  },
                ],
              }],
              provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: state.responseMode }),
              artifacts: clarificationRetrievalArtifacts,
              totalSteps: 1,
              totalToolCalls: clarificationRetrievalToolCalls.length,
              maxStepsReached: false,
              timestamp: new Date(),
              durationMs: Date.now() - startTime,
            });
          } catch (error: any) {
            logger.warn("Failed to record RAG answer trace", { error: error.message });
          }
          
          // Small delay to ensure SSE stream is subscribed before emitting
          await new Promise(resolve => setTimeout(resolve, 100));
          
          emitFinalEvent(eventBus, sessionId, startTime, cleanedAnswer, {
            ragAnswer: true,
            ragScore: ragPayload.sTotalScore,
            classification: state.classification,
            conversationState: state.postExecutionState,
            conversationContext: state.finalContextUpdate,
            traceId,
          });
          return { text: cleanedAnswer };
        }
        
        // RAG didn't have a good answer, fall through to clarification
        logger.info("RAG did not provide sufficient answer, proceeding with clarification", {
          ragScore: ragPayload.sTotalScore,
          hasAnswer: !!ragPayload.answer,
        });
      } else {
        clarificationRetrievalDecisions.push({
          type: "retrieval_not_injected",
          description: "Retrieval request failed or returned no payload.",
          metadata: { reason: "unavailable" },
        });
      }
    } else if (isRealTimeMetricQuery) {
      // Real-time metric queries should use tools, not RAG
      logger.info("Skipping RAG for real-time metric query - will use tools instead", {
        query: userInput.slice(0, 100),
        domain: state.classification.metadata?.domain,
      });
      clarificationRetrievalDecisions.push({
        type: "retrieval_skipped",
        description: "Retrieval skipped for real-time metric query.",
        metadata: { reason: "real_time_metrics" },
      });
    } else {
      clarificationRetrievalDecisions.push({
        type: "retrieval_skipped",
        description: "Retrieval skipped before clarification.",
        metadata: { reason: "low_confidence_no_domain" },
      });
    }
    
    // Generate clarification message based on classification
    let clarificationMessage: string;
    if (state.classification.confidence < 0.2) {
      clarificationMessage = "I'm not sure what you're asking. Could you rephrase your question?";
    } else if (state.classification.metadata?.domain) {
      const domain = state.classification.metadata.domain;
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
    let clarificationTraceId: string | undefined;
    try {
      const traceStore = getReasoningTraceStore();
      const clarificationStep: ReasoningStep = {
        step: 1,
        toolCalls: clarificationRetrievalToolCalls,
        decisions: [
          ...clarificationRetrievalDecisions,
          {
            type: "clarification_requested",
            description: `Confidence ${state.classification.confidence.toFixed(2)} below threshold for ${state.classification.type} intent`,
            metadata: { classification: state.classification, routing: state.routing },
          },
        ],
      };
      if (clarificationRagContextId) clarificationStep.ragContextId = clarificationRagContextId;
      if (clarificationGraphContextId) clarificationStep.graphContextId = clarificationGraphContextId;
      if (clarificationFusionContextId) clarificationStep.fusionContextId = clarificationFusionContextId;

      clarificationTraceId = await traceStore.recordTrace({
        userId: session.userId,
        aclGroup: session.aclGroup,
        userInput,
        finalResponse: clarificationMessage,
        steps: [clarificationStep],
        provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: state.responseMode }),
        artifacts: clarificationRetrievalArtifacts,
        totalSteps: 1,
        totalToolCalls: clarificationRetrievalToolCalls.length,
        maxStepsReached: false,
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
      });
    } catch (error: any) {
      logger.warn("Failed to record clarification trace", { error: error.message });
    }
    
    // Small delay to ensure SSE stream is subscribed before emitting
    await new Promise(resolve => setTimeout(resolve, 100));
    
    emitFinalEvent(eventBus, sessionId, startTime, clarificationMessage, {
      clarification: true,
      needsResponse: true,
      classification: state.classification,
      conversationState: state.conversationPlan.nextState,
      conversationContext: state.contextUpdate,
      traceId: clarificationTraceId,
    });
    return { text: clarificationMessage };
    } // end else (canHandleDirectlyFromRoute was false)
  }

  // Check action intent FIRST (before ALL query intents)
  // This prevents action requests from being treated as queries
  // Compound application requests must stay intact for application_lifecycle;
  // the legacy create_vm fast path only provisions the VM and would discard
  // service, firewall, asset, DNS, and identity requirements.
  const actionIntent = compoundApplicationRequest ? null : detectActionIntent(userInput);
  let resolvedVmContext: string | null = null;
  
  if (compoundApplicationRequest) {
    logger.info("Routing compound request to application lifecycle", {
      vmName: compoundApplicationRequest.vmName,
      node: compoundApplicationRequest.node,
    });
    const manifest = buildApplicationManifest(compoundApplicationRequest, {
      input: userInput,
      sshUsername: options.getProfileSshUsername?.(session.userId) ?? undefined,
    });
    emitStepEvent(eventBus, sessionId, {
      step: 1,
      maxSteps: 1,
      userInput,
      intent: "application_lifecycle",
      tool: "application_lifecycle",
    });
    const toolCallId = `application-lifecycle-${Date.now()}`;
    eventBus.emit({
      type: "tool:start",
      sessionId,
      timestamp: Date.now(),
      data: {
        type: "tool:start",
        toolName: "application_lifecycle",
        parameters: manifest,
        toolCallId,
      },
    });
    const result = await executeToolCall(
      { toolName: "application_lifecycle", parameters: manifest },
      tools,
      { userId: session.userId, aclGroup: session.aclGroup, node: compoundApplicationRequest.node }
    );
    eventBus.emit({
      type: "tool:complete",
      sessionId,
      timestamp: Date.now(),
      data: {
        type: "tool:complete",
        toolName: "application_lifecycle",
        parameters: manifest,
        toolCallId,
        success: !result.error,
        error: result.error,
        durationMs: result.durationMs,
      },
    });
    const application = manifest.applications[0]!;
    const answer = result.error
      ? `Application deployment failed | vm=${application.vms[0]!.name} | node=${application.vms[0]!.node} | error=${result.error}`
      : `Application deployed | vm=${application.vms[0]!.name} | node=${application.vms[0]!.node} | domain=${application.domain}`;
    const durationMs = Date.now() - startTime;
    let traceId: string | undefined;
    try {
      traceId = await getReasoningTraceStore().recordTrace({
        userId: session.userId,
        aclGroup: session.aclGroup,
        userInput,
        finalResponse: answer,
        steps: [{
          step: 1,
          toolCalls: [{
            toolName: "application_lifecycle",
            parameters: manifest,
            result: { success: !result.error, error: result.error },
            durationMs: result.durationMs ?? durationMs,
          }],
          decisions: [{
            type: "tool_choice",
            description: "Compiled the confirmed compound request into one application lifecycle manifest.",
            metadata: { mode: "deterministic_manifest", requestId: manifest.requestId },
          }],
        }],
        provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: state.responseMode }),
        totalSteps: 1,
        totalToolCalls: 1,
        maxStepsReached: false,
        timestamp: new Date(),
        durationMs,
      });
    } catch (error: unknown) {
      logger.warn("Failed to record application lifecycle trace", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    emitFinalEvent(eventBus, sessionId, startTime, answer, {
      traceId,
      conversationState: state.postExecutionState,
      conversationContext: state.finalContextUpdate,
      totalSteps: 1,
      totalToolCalls: 1,
    });
    return { text: answer };
  } else if (actionIntent) {
    logger.info("Detected action intent", { intent: actionIntent.type });

    if (actionIntent.type === "install_service" && ["nginx", "docker"].includes(actionIntent.service)) {
      const actionName = actionIntent.service === "nginx" ? "services.install_nginx" : "services.install_docker";
      emitStepEvent(eventBus, sessionId, { step: 1, maxSteps: 1, userInput, intent: "install_service", tool: "action" });
      const result = await executeToolCall({
        toolName: "action",
        parameters: { action: actionName, params: { vmName: actionIntent.vmName } },
      }, tools, { userId: session.userId, aclGroup: session.aclGroup, sessionId });
      const data = (result as any)?.data;
      const ok = (result as any)?.success === true || data?.success === true;
      const message = data?.message || (result as any)?.message || (result as any)?.error || "Action completed.";
      let connections: ConnectionEndpoint[] = [];
      const parsedTarget = ConnectionTargetSchema.safeParse(data?.connectionTarget);
      if (ok && parsedTarget.success) {
        const target = await resolveConnectionTarget(parsedTarget.data);
        const candidates = buildConnectionEndpoints(target);
        if (candidates.length > 0) {
          eventBus.emit({ type: "connection:update", sessionId, timestamp: Date.now(), data: { type: "connection:update", phase: "candidates", resource: target.hostname, endpoints: candidates } });
          connections = await verifyConnectionEndpoints(candidates, target.ipAddresses, {
            signal: options.signal,
            sshDeadlineMs: Number(process.env.CONNECTION_SSH_DEADLINE_MS || 300_000),
            httpDeadlineMs: Number(process.env.CONNECTION_HTTP_DEADLINE_MS || 120_000),
            retryIntervalMs: Number(process.env.CONNECTION_RETRY_INTERVAL_MS || 5_000),
            onUpdate: (endpoints) => {
              eventBus.emit({ type: "connection:update", sessionId, timestamp: Date.now(), data: {
                type: "connection:update",
                phase: endpoints.every((endpoint) => endpoint.status !== "pending") ? "complete" : "verifying",
                resource: target.hostname,
                endpoints,
              } });
            },
          });
          data.connections = connections;
        }
      }
      const text = ok
        ? `ServiceInstall | service=${actionIntent.service} | vm=${actionIntent.vmName} | message=${formatStructuredFieldValue(message)}`
        : `Error | action=${actionName} | vm=${actionIntent.vmName} | message=${formatStructuredFieldValue(message)}`;
      const structuredResponse = createTextAgentResponse(text, { state: "IDLE" });
      if (connections.length > 0) structuredResponse.answer.sections.push({ type: "connections", title: "Connections", data: connections });
      emitFinalEvent(eventBus, sessionId, startTime, text, {
        classification: state.classification,
        conversationState: state.postExecutionState,
        conversationContext: state.finalContextUpdate,
        totalSteps: 1,
        totalToolCalls: 1,
        structuredResponse,
        connections,
      });
      return { text };
    }

    // Deterministic fast-path: create VM requests must include a node; we already extracted it.
    // This avoids relying on the LLM to remember required action params (node is required by CreateVmSchema).
    if (actionIntent.type === "create_vm") {
      const node = (actionIntent as any).node as string | undefined;
      const name = (actionIntent as any).name as string | undefined;
      if (!node) {
        // Shouldn't happen (detectActionIntent requires node), but keep a safe fallback.
        const prompt = "Which node should I create the VM on? (e.g., yin, YANG, proxBig)";
        emitFinalEvent(eventBus, sessionId, startTime, prompt, {
          clarification: true,
          needsResponse: true,
          conversationState: "NEED_CLARIFICATION",
          conversationContext: contextUpdate,
        });
        return { text: prompt };
      }

      emitStepEvent(eventBus, sessionId, { step: 1, maxSteps: 1, userInput, intent: "create_vm", tool: "action" });

      const params: Record<string, any> = { node };
      if (name && name.trim().length > 0) params.name = name.trim();
      Object.assign(params, extractCreateVmParameters(userInput));
      if (/\bdry(?:\s|-)*run\b/i.test(userInput) || /\bpreview\b/i.test(userInput) || /\bplan\b/i.test(userInput)) {
        params.dryRun = true;
      }
      if (options.getProfilePublicKey && session.userId) {
        const profileKey = options.getProfilePublicKey(session.userId);
        if (profileKey && profileKey.trim().length > 0) params.sshPublicKey = profileKey.trim();
      }
      if (options.getProfileSshUsername && session.userId) {
        const profileUser = options.getProfileSshUsername(session.userId);
        if (profileUser && profileUser.trim().length > 0) params.sshUsername = profileUser.trim();
      }

      const result = await executeToolCall(
        {
          toolName: "action",
          parameters: {
            action: "compute.create_vm",
            params,
          },
        },
        tools,
        { userId: session.userId, aclGroup: session.aclGroup, sessionId }
      );

      const data = (result as any)?.data;
      const ok = (result as any)?.success === true || data?.success === true;
      const message = data?.message || (result as any)?.message || (result as any)?.error || "Action completed.";
      const vmId = data?.vmId || data?.vmid || data?.id;
      const hostname = data?.hostname || data?.name;
      let connections: ConnectionEndpoint[] = [];

      const connectionTarget = ConnectionTargetSchema.safeParse(data?.connectionTarget);
      if (ok && connectionTarget.success) {
        const target = await resolveConnectionTarget(connectionTarget.data);
        options.signal?.throwIfAborted();
        const candidates = buildConnectionEndpoints(target);
        if (candidates.length > 0) {
          eventBus.emit({
            type: "connection:update",
            sessionId,
            timestamp: Date.now(),
            data: { type: "connection:update", phase: "candidates", resource: target.hostname, endpoints: candidates },
          });
          eventBus.emitProgress({
            toolName: "connection_verifier",
            action: "verify_connections",
            status: "verifying",
            message: `Verifying ${candidates.length} connection endpoint(s) for ${target.hostname}...`,
            progress: 0.85,
          }, sessionId);
          connections = await verifyConnectionEndpoints(candidates, target.ipAddresses, {
            signal: options.signal,
            sshDeadlineMs: Number(process.env.CONNECTION_SSH_DEADLINE_MS || 300_000),
            retryIntervalMs: Number(process.env.CONNECTION_RETRY_INTERVAL_MS || 5_000),
            onUpdate: (endpoints) => {
              eventBus.emit({
                type: "connection:update",
                sessionId,
                timestamp: Date.now(),
                data: {
                  type: "connection:update",
                  phase: endpoints.every((endpoint) => endpoint.status !== "pending") ? "complete" : "verifying",
                  resource: target.hostname,
                  endpoints,
                },
              });
            },
          });
          data.connections = connections;
          const failed = connections.some((endpoint) => endpoint.status === "failed");
          eventBus.emitProgress({
            toolName: "connection_verifier",
            action: "verify_connections",
            status: failed ? "failed" : "completed",
            message: `${connections.filter((endpoint) => endpoint.status === "verified").length}/${connections.length} connection endpoint(s) verified for ${target.hostname}.`,
            progress: 1,
          }, sessionId);
        }
      }

      const text = ok
        ? `VMCreate | node=${node} | ${hostname ? `name=${hostname} | ` : ""}${vmId ? `vmid=${vmId} | ` : ""}message=${formatStructuredFieldValue(message)}`
        : `Error | action=compute.create_vm | node=${node} | message=${formatStructuredFieldValue(message)}`;

      let createVmTraceId: string | undefined;
      try {
        const traceStore = getReasoningTraceStore();
        const durationMs = Date.now() - startTime;
        createVmTraceId = await traceStore.recordTrace({
          userId: session.userId,
          aclGroup: session.aclGroup,
          userInput,
          finalResponse: text,
	          steps: [{
	            step: 1,
	            toolCalls: [{
	              toolName: "action",
	              parameters: { action: "compute.create_vm", params: { node, ...params } },
	              result: ok
	                ? {
	                    success: true,
	                    dataPreview: JSON.stringify({ vmId, hostname, message }),
	                    dataSize: JSON.stringify({ vmId, hostname, message }).length,
	                    resultType: "create_vm",
	                  }
	                : {
	                    success: false,
	                    error: String(message),
	                  },
	              durationMs,
	            }],
            decisions: [{
              type: "tool_choice",
              description: "Direct action: compute.create_vm",
              metadata: { intent: "create_vm", node },
            }],
          }],
          provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: state.responseMode }),
          totalSteps: 1,
          totalToolCalls: 1,
          maxStepsReached: false,
          timestamp: new Date(),
          durationMs,
        });
      } catch (error: any) {
        logger.warn("Failed to record reasoning trace for create_vm", { error: error.message });
      }

      const structuredResponse = createTextAgentResponse(text, {
        state: "IDLE",
        traceId: createVmTraceId,
      });
      if (connections.length > 0) {
        structuredResponse.answer.sections.push({ type: "connections", title: "Connections", data: connections });
      }
      emitFinalEvent(eventBus, sessionId, startTime, text, {
        classification: state.classification,
        conversationState: state.postExecutionState,
        conversationContext: state.finalContextUpdate,
        traceId: createVmTraceId,
        structuredResponse,
        connections,
      });
      return { text };
    }

    if (actionIntent.type === "destroy_vm") {
      const requestedNode = (actionIntent as any).node as string | undefined;
      const requestedName = (actionIntent as any).name as string | undefined;
      const requestedVmId = (actionIntent as any).vmId as number | undefined;
      const lookup = requestedVmId ? String(requestedVmId) : requestedName;

      let resolvedDestroyVm: ResolvedVmDetails | null = null;
      if (!lookup) {
        const prompt = "Which VM should I destroy? Provide a VM name or VMID.";
        emitFinalEvent(eventBus, sessionId, startTime, prompt, {
          clarification: true,
          needsResponse: true,
          conversationState: "NEED_CLARIFICATION",
          conversationContext: contextUpdate,
        });
        return { text: prompt };
      }

      try {
        const resolved = await resolveVmDetailsChain(tools, session, lookup);
        if (!resolved.found) {
          const prompt = requestedVmId
            ? `I couldn't find VMID ${requestedVmId}.`
            : `I couldn't find VM "${requestedName}".`;
          emitFinalEvent(eventBus, sessionId, startTime, prompt, {
            clarification: true,
            needsResponse: true,
            conversationState: "NEED_CLARIFICATION",
            conversationContext: contextUpdate,
          });
          return { text: prompt };
        }
        resolvedDestroyVm = resolved;
      } catch (error: any) {
        const prompt = `I couldn't resolve the VM details: ${error.message}`;
        emitFinalEvent(eventBus, sessionId, startTime, prompt, {
          clarification: true,
          needsResponse: true,
          conversationState: "NEED_CLARIFICATION",
          conversationContext: contextUpdate,
        });
        return { text: prompt };
      }

      if (
        requestedNode &&
        resolvedDestroyVm &&
        requestedNode.toLowerCase() !== resolvedDestroyVm.node.toLowerCase()
      ) {
        const prompt =
          `VM "${resolvedDestroyVm.name}" (VMID ${resolvedDestroyVm.vmid}) is on node "${resolvedDestroyVm.node}", not "${requestedNode}". ` +
          "Confirm the correct node or VM target.";
        emitFinalEvent(eventBus, sessionId, startTime, prompt, {
          clarification: true,
          needsResponse: true,
          conversationState: "NEED_CLARIFICATION",
          conversationContext: contextUpdate,
        });
        return { text: prompt };
      }

      emitStepEvent(eventBus, sessionId, { step: 1, maxSteps: 1, userInput, intent: "destroy_vm", tool: "action" });

      const params: Record<string, any> = {};
      const resolvedName = resolvedDestroyVm?.name?.trim();
      const requestedTrimmedName = requestedName?.trim();
      const canonicalDestroyName =
        resolvedName && resolvedName.length > 0
          ? resolvedName
          : requestedTrimmedName && requestedTrimmedName.length > 0
            ? requestedTrimmedName
            : undefined;
      if (canonicalDestroyName) params.name = canonicalDestroyName;
      if (typeof requestedVmId === "number") params.vmId = requestedVmId;
      if (resolvedDestroyVm?.node) params.node = resolvedDestroyVm.node;
      else if (requestedNode && requestedNode.trim().length > 0) params.node = requestedNode.trim();
      if (/\bdry\s*run\b/i.test(userInput) || /\bdryrun\b/i.test(userInput) || /\bpreview\b/i.test(userInput) || /\bplan\b/i.test(userInput)) {
        params.dryRun = true;
      }

      const result = await executeToolCall(
        {
          toolName: "action",
          parameters: {
            action: "compute.destroy_vm",
            params,
          },
        },
        tools,
        { userId: session.userId, aclGroup: session.aclGroup }
      );

      const data = (result as any)?.data;
      const ok = (result as any)?.success === true || data?.success === true;
      const message = data?.message || (result as any)?.message || (result as any)?.error || "Action completed.";
      const vmId = requestedVmId ?? resolvedDestroyVm?.vmid;
      const vmName = canonicalDestroyName ?? requestedTrimmedName ?? resolvedDestroyVm?.name;
      const vmNode = params.node ?? requestedNode ?? resolvedDestroyVm?.node;

      const text = ok
        ? `VMDestroy | ${vmNode ? `node=${vmNode} | ` : ""}${vmName ? `name=${vmName} | ` : ""}${vmId ? `vmid=${vmId} | ` : ""}message=${formatStructuredFieldValue(message)}`
        : `Error | action=compute.destroy_vm | ${vmNode ? `node=${vmNode} | ` : ""}message=${formatStructuredFieldValue(message)}`;

      let destroyVmTraceId: string | undefined;
      try {
        const traceStore = getReasoningTraceStore();
        const durationMs = Date.now() - startTime;
        destroyVmTraceId = await traceStore.recordTrace({
          userId: session.userId,
          aclGroup: session.aclGroup,
          userInput,
          finalResponse: text,
          steps: [{
            step: 1,
            toolCalls: [{
              toolName: "action",
              parameters: { action: "compute.destroy_vm", params },
              result: ok
                ? {
                    success: true,
                    dataPreview: JSON.stringify({ vmId, vmName, vmNode, message }),
                    dataSize: JSON.stringify({ vmId, vmName, vmNode, message }).length,
                    resultType: "destroy_vm",
                  }
                : {
                    success: false,
                    error: String(message),
                  },
              durationMs,
            }],
            decisions: [{
              type: "tool_choice",
              description: "Direct action: compute.destroy_vm",
              metadata: { intent: "destroy_vm", vmName: vmName ?? "", vmId: vmId ?? null, node: vmNode ?? null },
            }],
          }],
          provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: state.responseMode }),
          totalSteps: 1,
          totalToolCalls: 1,
          maxStepsReached: false,
          timestamp: new Date(),
          durationMs,
        });
      } catch (error: any) {
        logger.warn("Failed to record reasoning trace for destroy_vm", { error: error.message });
      }

      emitFinalEvent(eventBus, sessionId, startTime, text, {
        classification: state.classification,
        conversationState: state.postExecutionState,
        conversationContext: state.finalContextUpdate,
        traceId: destroyVmTraceId,
      });
      return { text };
    }

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
  } else if (classification.intent !== "ACTION") {
    // Only check query intents when the classifier also considers this a read.
    // An ACTION that the deterministic parser does not recognize must continue
    // to the LLM action path instead of being intercepted by a twin-first read.
    // Composite queries (e.g. node + exposure, subnet + level) skip twin-first and use EXECUTE path.
    const directFirewallIntent = detectFirewallIntent(userInput);
    const supportsDirectFirewallComposite =
      directFirewallIntent?.type === "allowed_ports_between";
    if (isCompositeQuery && !supportsDirectFirewallComposite) {
      logger.info("Composite query detected, skipping twin-first chains and using EXECUTE path", {
        userInput: userInput.slice(0, 80),
        compositeFromMetadata: classification?.metadata?.composite === true,
      });
    }
    if (!isCompositeQuery || supportsDirectFirewallComposite) {
    // Check exposure intent first (most specific).
    // Exposure is cross-domain — fire when domain is "compute", "general", or absent.
    // Suppressed for purely network/firewall/metrics queries to avoid false positives.
    const exposureDomain = classification.metadata?.domain;
    if (!exposureDomain || exposureDomain === "compute" || exposureDomain === "general") {
    const exposureIntent = detectExposureIntent(userInput);
    if (exposureIntent) {
      const exposureAnswer = await executeExposureIntent(exposureIntent, tools, session);
      if (exposureAnswer) {
        logger.info("Responding via twin-first exposure reasoning chain.");
        emitStepEvent(eventBus, sessionId, { step: 1, maxSteps: 1, intent: exposureIntent.type, mode: "twin_first", tool: "twin_query" });
        
        // Format exposure response for bot-like style
        let formattedAnswer = exposureAnswer;
        try {
          formattedAnswer = await formatResponseForBot(exposureAnswer, {
            userQuery: userInput,
            intentType: "exposure_analysis",
            toolCalls: [{ toolName: "twin_query", parameters: { operation: exposureIntent.type } }],
            mode: state.responseMode,
          });
        } catch (error: any) {
          logger.warn("Failed to format exposure answer", { error: error.message });
        }
        
        const traceId = await recordEarlyReturnTrace(formattedAnswer, exposureIntent.type, 1);
        emitFinalEvent(eventBus, sessionId, startTime, formattedAnswer, {
          intent: exposureIntent.type,
          traceId,
          conversationState: state.postExecutionState,
          conversationContext: state.finalContextUpdate,
        });
        return { text: formattedAnswer };
      }
    }
    } // end exposure domain gate

    // Skip compute intent if this is a diagnostic/troubleshooting request
    // Diagnostic requests should go to the LLM to use infrastructure_diagnostic tool
    if (!classification.metadata?.domain || classification.metadata.domain === "compute") {
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
        emitStepEvent(eventBus, sessionId, { step: 1, maxSteps: 1, intent: computeIntent.type, mode: "twin_first", tool: "twin_query" });
        
        // Format compute response for bot-like style
        let formattedAnswer = twinAnswer;
        try {
          formattedAnswer = await formatResponseForBot(twinAnswer, {
            userQuery: userInput,
            intentType: "compute_status",
            toolCalls: [{ toolName: "twin_query", parameters: { operation: computeIntent.type } }],
            mode: state.responseMode,
          });
        } catch (error: any) {
          logger.warn("Failed to format compute answer", { error: error.message });
        }
        
        const traceId = await recordEarlyReturnTrace(formattedAnswer, computeIntent.type, 1);
        emitFinalEvent(eventBus, sessionId, startTime, formattedAnswer, {
          intent: computeIntent.type,
          traceId,
          conversationState: state.postExecutionState,
          conversationContext: state.finalContextUpdate,
        });
        return { text: formattedAnswer };
      }
    }
    } // end compute domain gate

    // Check firewall QUERY intent (only if no action intent detected)
    // Action intents like "configure firewall" are handled above
    const firewallIntent = directFirewallIntent;
    const firewallDomain = classification.metadata?.domain;
    if (firewallIntent && (!firewallDomain || firewallDomain === "firewall" || firewallDomain === "network")) {
      const firewallAnswer = await executeFirewallIntent(firewallIntent, tools, session);
      if (firewallAnswer) {
        logger.info("Responding via twin-first firewall reasoning chain.");
        const firewallToolCalls = buildFirewallToolCalls(firewallIntent);
        emitStepEvent(eventBus, sessionId, {
          step: 1,
          maxSteps: 1,
          intent: firewallIntent.type,
          mode: "twin_first",
          tool: firewallToolCalls[0]?.toolName ?? "unknown",
        });
        
        // Format firewall response — use ASSISTIVE by default so the LLM synthesizes
        // the raw chain output into a clear answer with evidence. Fall back to user's
        // responseMode if one was explicitly chosen (e.g. TERSE_DATA or EXPLAINER).
        const firewallSummaryWords = /\b(summarize|explain|describe|overview|why|how)\b/i.test(userInput);
        const firewallMode: ResponseMode = state.responseMode ?? (firewallSummaryWords ? "EXPLAINER" : "ASSISTIVE");
        let formattedAnswer = firewallAnswer;
        if (
          firewallIntent.type !== "sources_accessing_network" &&
          firewallIntent.type !== "allowed_ports_between"
        ) {
          try {
            formattedAnswer = await formatResponseForBot(firewallAnswer, {
              userQuery: userInput,
              intentType: "firewall_rules",
              toolCalls: firewallToolCalls,
              mode: firewallMode,
            });
          } catch (error: any) {
            logger.warn("Failed to format firewall answer", { error: error.message });
          }
        }
        
        const traceId = await recordEarlyReturnTrace(
          formattedAnswer,
          firewallIntent.type,
          firewallToolCalls.length,
          firewallToolCalls
        );
        emitFinalEvent(eventBus, sessionId, startTime, formattedAnswer, {
          intent: firewallIntent.type,
          traceId,
          conversationState: state.postExecutionState,
          conversationContext: state.finalContextUpdate,
        });
        return { text: formattedAnswer };
      }
    }
    // end firewall domain gate

    // Only check network intent if no action, exposure, compute, or firewall intent was detected
    if (!classification.metadata?.domain || classification.metadata.domain === "network") {
    const networkIntent = detectNetworkIntent(userInput);
    if (networkIntent) {
      const networkAnswer = await executeNetworkIntent(networkIntent, tools, session);
      if (networkAnswer) {
        logger.info("Responding via twin-first network reasoning chain.");
        emitStepEvent(eventBus, sessionId, { step: 1, maxSteps: 1, intent: networkIntent.type, mode: "twin_first", tool: "twin_query" });
        
        // Format network response for bot-like style
        let formattedAnswer = networkAnswer;
        try {
          const usesIngestionSummary = [
            "vm_networks",
            "vm_by_ip",
            "vms_with_multiple_interfaces",
          ].includes(networkIntent.type);
          const toolCalls =
            networkIntent.type === "vm_ip_by_name"
              ? [
                  { toolName: "twin_query", parameters: { operation: "find_vm_by_name" } },
                  { toolName: "proxmox_readonly", parameters: { action: "get_vm_ip" } },
                ]
              : usesIngestionSummary
                ? [{ toolName: "ingestion_summary_store", parameters: { snapshot: "latest" } }]
                : [{ toolName: "twin_query", parameters: { operation: networkIntent.type } }];
          const networkSummaryWords = /\b(summarize|explain|describe|overview|why|how)\b/i.test(userInput);
          const networkMode: ResponseMode = state.responseMode ?? (networkSummaryWords ? "EXPLAINER" : "ASSISTIVE");
          formattedAnswer = await formatResponseForBot(networkAnswer, {
            userQuery: userInput,
            intentType: "network_info",
            toolCalls,
            mode: networkMode,
          });
        } catch (error: any) {
          logger.warn("Failed to format network answer", { error: error.message });
        }
        
        const traceId = await recordEarlyReturnTrace(formattedAnswer, networkIntent.type, 1);
        emitFinalEvent(eventBus, sessionId, startTime, formattedAnswer, {
          intent: networkIntent.type,
          traceId,
          conversationState: state.postExecutionState,
          conversationContext: state.finalContextUpdate,
        });
        return { text: formattedAnswer };
      }
    }
    } // end network domain gate
    }
  }

  // Execute path: RAG → LLM loop → tool dispatch
  const executeResult = await handleExecute({
    state,
    userInput,
    session,
    options,
    tools,
    context,
    eventBus,
    sessionId,
    startTime,
    policyMode,
    toolRegistryVersion,
    failureTracker,
    actionIntent,
    resolvedVmContext,
    isCompositeQuery,
    confirmation,
    pendingActionId,
    pendingActionCreatedAt,
    pendingActionExpiresAt,
    pendingActionExpired,
    pendingActionPreview,
    pendingActionSummary,
    pendingActionExecuteInput,
    pendingAction,
    usedPendingAction,
    entityCache: options.conversationContext?.resolvedEntities ?? {},
  });

  // Merge any newly resolved entities back into the final context update so
  // the caller can persist them for the next turn.
  if (executeResult.entityCacheUpdate && Object.keys(executeResult.entityCacheUpdate).length > 0) {
    state.finalContextUpdate.resolvedEntities = {
      ...options.conversationContext?.resolvedEntities,
      ...executeResult.entityCacheUpdate,
    };
  }

  return executeResult;
}
