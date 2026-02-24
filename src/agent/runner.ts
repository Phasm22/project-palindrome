import readline from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { AgentResponse } from "../types/agent";
import type { ExecutionResult } from "../types/execution";
import type { ConversationContext, ConversationState, UserPreferences } from "../types";
import { logger } from "../utils/logger";
import { loadTools } from "./tool-loader";
import { executeToolCall } from "./tool-executor";
import { AgentContext } from "./context";
import { SYSTEM_PROMPT } from "./system-prompt";
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
} from "../reasoning/chains/network";
import { detectFirewallIntent, type FirewallIntent } from "../reasoning/detectFirewallIntent";
import {
  listFirewallRulesChain,
  countFirewallRulesChain,
  allowedPortsBetweenChain,
  firewallRulesByChainChain,
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
import { detectActionIntent } from "../reasoning/action-intents";
import {
  loadKnownEntitiesFromIngestionSummary,
  loadKnownEntitiesFromProxmox,
} from "../reasoning/clarification";
import { classifyAndRoute } from "../reasoning/intent-router";
import { reclassifyIntentWithContext, FailureTracker, type FailureContext } from "../reasoning/failure-reclassification";
import { formatResponseForBot, detectResponseIntent, type FormatContext, type ResponseMode } from "./response-formatter";
import { planConversation } from "./conversation-orchestrator";
import { parseConfirmationInput } from "./dialog-policy";
import { resolveClarificationContinuationInput } from "./clarification-continuation";
import { deriveToolCallRisk, mapToolRiskToIntentRisk, maxRisk } from "./tool-risk";
import { pceLogger } from "../pce/utils/logger";
import { TerraformRunner } from "../actions/helpers/terraform-runner";

let openaiClient: OpenAI | null = null;
const ASSISTANT_NAME = "Pally";
const PROMPT_HASH = createHash("sha256").update(SYSTEM_PROMPT).digest("hex");
const PROMPT_VERSION = process.env.PROMPT_VERSION ?? PROMPT_HASH.slice(0, 8);
const MODEL_ID = "gpt-4o-mini";
let cachedAgentVersion: string | null = null;

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

function buildProvenance(params: {
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

const RETRIEVAL_MIN_SCORE = 0.35;

function getRetrievalEligibility(params: {
  intent: string;
  isTrivialQuery: boolean;
  isActionIntent: boolean;
  isRealTimeMetricQuery: boolean;
  isMetaIdentityQuery: boolean;
}): { eligible: boolean; reason?: string } {
  if (params.isMetaIdentityQuery) {
    return { eligible: false, reason: "meta_identity" };
  }
  if (params.intent === "CHAT_SOCIAL") {
    return { eligible: false, reason: "chat_social" };
  }
  if (params.intent === "CLARIFICATION") {
    return { eligible: false, reason: "clarification" };
  }
  if (params.isTrivialQuery) {
    return { eligible: false, reason: "trivial_query" };
  }
  if (params.isActionIntent) {
    return { eligible: false, reason: "action_intent" };
  }
  if (params.isRealTimeMetricQuery) {
    return { eligible: false, reason: "real_time_metrics" };
  }
  if (params.intent !== "QUERY" && params.intent !== "CHAT_REASONING") {
    return { eligible: false, reason: "intent_not_retrieval" };
  }
  return { eligible: true };
}

function hasDomainMatch(domain: string | undefined, rag: HybridApiContext): boolean {
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

function buildRetrievalArtifacts(rag: HybridApiContext): {
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

function buildRetrievalToolCalls(rag: HybridApiContext): ReasoningStep["toolCalls"] {
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

function buildConversationMemoryPrompt(context?: ConversationContext): string | null {
  if (!context) return null;
  const parts: string[] = [];
  if (context.userName) parts.push(`user_name=${context.userName}`);
  if (parts.length === 0) return null;
  return `Conversation memory (chat scope only): ${parts.join(" | ")}`;
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
      case "allowed_ports_between":
        return await allowedPortsBetweenChain(intent.from, intent.to, tools, session);
      case "rules_by_chain":
        return await firewallRulesByChainChain(intent.chain, tools, session);
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
    case "allowed_ports_between":
      return [{ toolName: "opnsense_readonly", parameters: { action: "firewall_rules_list" } }];
    case "rules_by_chain":
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
  /** When set (e.g. by PCE API), used to inject profile public key into create_vm params for dashboard users */
  getProfilePublicKey?: (userId: string) => string | null;
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

  if (confirmation.cancelled) {
    const prompt = pendingActionId
      ? "Cancelled the pending change. Nothing was applied."
      : "There is no pending change to cancel.";
    emitFinalEvent(prompt, {
      clarification: true,
      needsResponse: true,
      conversationState: "IDLE",
      conversationContext: {
        pendingAction: "",
        pendingActionId: "",
        pendingActionDigest: "",
        pendingActionCreatedAt: 0,
        pendingActionSummary: "",
        pendingActionType: "",
        pendingActionPreview: "",
        pendingActionExecuteInput: "",
        pendingActionExpiresAt: 0,
      },
    });
    pceLogger.incrementCounter("confirmation_rejected");
    return { text: prompt };
  }

  if (confirmation.confirmed && !pendingActionId) {
    const prompt = "There is no pending action to confirm. Re-submit the change request first.";
    emitFinalEvent(prompt, {
      clarification: true,
      needsResponse: true,
      conversationState: "IDLE",
    });
    pceLogger.incrementCounter("confirmation_mismatch");
    return { text: prompt };
  }

  if (confirmation.confirmed && !confirmation.actionId && pendingActionId) {
    const prompt = `Pending change requires explicit confirmation. Reply with CONFIRM ${pendingActionId} to apply, or CANCEL.`;
    emitFinalEvent(prompt, {
      clarification: true,
      needsResponse: true,
      conversationState: "AWAITING_CONFIRMATION",
      conversationContext: {
        pendingAction,
        pendingActionId,
        pendingActionDigest: options.conversationContext?.pendingActionDigest,
        pendingActionCreatedAt,
        pendingActionSummary,
        pendingActionPreview,
        pendingActionExecuteInput,
        pendingActionExpiresAt,
      },
      confirmationRequired: true,
      confirmationId: pendingActionId,
      confirmationPreview: pendingActionPreview ?? pendingActionSummary ?? pendingAction ?? "",
      confirmationExpiresAt: pendingActionExpiresAt ?? 0,
    });
    pceLogger.incrementCounter("confirmation_mismatch");
    return { text: prompt };
  }

  if (confirmation.confirmed && confirmation.actionId && pendingActionId && confirmation.actionId !== pendingActionId) {
    const prompt = `Confirmation id does not match the pending action. Reply with CONFIRM ${pendingActionId} to apply, or CANCEL.`;
    emitFinalEvent(prompt, {
      clarification: true,
      needsResponse: true,
      conversationState: "AWAITING_CONFIRMATION",
      conversationContext: {
        pendingAction,
        pendingActionId,
        pendingActionDigest: options.conversationContext?.pendingActionDigest,
        pendingActionCreatedAt,
        pendingActionSummary,
        pendingActionPreview,
        pendingActionExecuteInput,
        pendingActionExpiresAt,
      },
      confirmationRequired: true,
      confirmationId: pendingActionId,
      confirmationPreview: pendingActionPreview ?? pendingActionSummary ?? pendingAction ?? "",
      confirmationExpiresAt: pendingActionExpiresAt ?? 0,
    });
    pceLogger.incrementCounter("confirmation_mismatch");
    return { text: prompt };
  }

  if (confirmation.confirmed && pendingActionExpired && pendingActionId) {
    const prompt = "Confirmation expired. Please re-request the change.";
    emitFinalEvent(prompt, {
      clarification: true,
      needsResponse: true,
      conversationState: "IDLE",
      conversationContext: {
        pendingAction: "",
        pendingActionId: "",
        pendingActionDigest: "",
        pendingActionCreatedAt: 0,
        pendingActionSummary: "",
        pendingActionType: "",
        pendingActionPreview: "",
        pendingActionExecuteInput: "",
        pendingActionExpiresAt: 0,
      },
    });
    pceLogger.incrementCounter("confirmation_expired");
    return { text: prompt };
  }

  if (confirmation.confirmed && pendingActionExecuteInput && pendingActionId && confirmation.actionId === pendingActionId) {
    userInput = pendingActionExecuteInput;
    usedPendingAction = true;
    pceLogger.incrementCounter("confirmation_approved");
    // Keep confirmation intact so evaluateDialogPolicy can compute confirmationAllowed=true
    // and set decision=EXECUTE. Resetting confirmation here causes the replayed high-risk
    // action to loop back to ASK_CONFIRM because the policy sees no confirmation.
  }

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
        provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: responseMode }),
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

  const buildPendingActionRecord = (
    executeInput: string,
    summary?: string,
    type: string = "change_request"
  ) => {
    const createdAt = Date.now();
    const expiresAt = createdAt + 15 * 60 * 1000;
    const digest = createHash("sha256").update(executeInput).digest("hex");
    const id = digest.slice(0, 8);
    return {
      id,
      digest,
      createdAt,
      expiresAt,
      type,
      preview: summary ?? executeInput,
      executeInput,
      summary: summary ?? executeInput,
    };
  };

  const summarizeToolCall = (toolName: string, params: Record<string, any>): string => {
    if (toolName === "action" && params.action) {
      const actionName = String(params.action);
      const actionParams =
        params.params && typeof params.params === "object" && !Array.isArray(params.params)
          ? params.params
          : {};
      const detailParts: string[] = [];
      if (typeof actionParams.name === "string" && actionParams.name.trim().length > 0) {
        detailParts.push(`name ${actionParams.name.trim()}`);
      }
      if (typeof actionParams.node === "string" && actionParams.node.trim().length > 0) {
        detailParts.push(`node ${actionParams.node.trim()}`);
      }
      if (typeof actionParams.vmId === "number") {
        detailParts.push(`vmid ${actionParams.vmId}`);
      }
      if (typeof actionParams.vmid === "number") {
        detailParts.push(`vmid ${actionParams.vmid}`);
      }
      return detailParts.length > 0
        ? `action ${actionName} (${detailParts.join(", ")})`
        : `action ${actionName}`;
    }
    if (toolName === "proxmox_write" && params.action) {
      const target = params.vmid ? `vmid ${params.vmid}` : params.node ? `node ${params.node}` : "";
      return `proxmox_write ${params.action}${target ? ` ${target}` : ""}`;
    }
    if (toolName === "opnsense_safewrite" && params.action) {
      return `opnsense ${params.action}`;
    }
    return `${toolName} change`;
  };

  const formatStructuredFieldValue = (value: unknown): string => {
    return String(value ?? "")
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\|/g, "/")
      .trim();
  };

  const inferMissingToolSlots = (toolName: string, params: Record<string, any>): string[] => {
    const missing = new Set<string>();

    if (toolName === "action" && typeof params.action === "string") {
      const actionName = params.action;
      const actionParams =
        params.params && typeof params.params === "object" && !Array.isArray(params.params)
          ? params.params
          : {};

      if (actionName === "compute.create_vm") {
        const node =
          typeof actionParams.node === "string" ? actionParams.node.trim() : "";
        if (!node) {
          missing.add("target");
          missing.add("node");
        }
      }

      if (actionName === "compute.destroy_vm") {
        const hasName = typeof actionParams.name === "string" && actionParams.name.trim().length > 0;
        const hasVmId =
          typeof actionParams.vmId === "number" ||
          (typeof actionParams.vmid === "number") ||
          (typeof actionParams.vmId === "string" && actionParams.vmId.trim().length > 0) ||
          (typeof actionParams.vmid === "string" && actionParams.vmid.trim().length > 0);
        if (!hasName && !hasVmId) {
          missing.add("target");
        }
      }
    }

    if (toolName === "proxmox_write" && typeof params.action === "string") {
      const actionName = params.action.toLowerCase();
      const requiresVmTarget = ["start_vm", "stop_vm", "restart_vm", "destroy_vm"].includes(actionName);
      if (requiresVmTarget) {
        const hasNode = typeof params.node === "string" && params.node.trim().length > 0;
        const hasVmId =
          typeof params.vmid === "number" ||
          (typeof params.vmid === "string" && params.vmid.trim().length > 0);
        if (!hasNode) missing.add("node");
        if (!hasVmId) missing.add("vmid");
      }
    }

    return Array.from(missing);
  };

  const cleanupAfterProxmoxDestroy = async (vmName: string): Promise<void> => {
    const normalizedName = vmName.trim();
    const infraName = normalizedName.replace(/\.prox$/i, "");
    if (!infraName || infraName.toLowerCase() === "unknown") {
      return;
    }

    try {
      if (process.env.PIHOLE_WEB_PWD || process.env.PIHOLE_API_KEY) {
        const { getPiholeClient } = await import("../tools/pihole/client");
        const piholeClient = getPiholeClient();
        const dnsDomain = normalizedName.toLowerCase().endsWith(".prox")
          ? normalizedName
          : `${infraName}.prox`;
        const existingRecords = await piholeClient.listDnsRecords();
        const dnsRecord = existingRecords.find((record) => {
          const left = record.domain.toLowerCase().replace(/\.$/, "");
          const right = dnsDomain.toLowerCase().replace(/\.$/, "");
          return left === right;
        });
        if (dnsRecord) {
          await piholeClient.deleteDnsRecord(dnsRecord.domain, dnsRecord.ip);
          logger.info("Deleted DNS record after proxmox_write destroy_vm", {
            vmName: normalizedName,
            domain: dnsRecord.domain,
            ip: dnsRecord.ip,
          });
        } else {
          logger.warn("No DNS record found after proxmox_write destroy_vm", {
            vmName: normalizedName,
            expectedDomain: dnsDomain,
          });
        }
      }
    } catch (error: any) {
      logger.warn("Failed DNS cleanup after proxmox_write destroy_vm", {
        vmName: normalizedName,
        error: error.message,
      });
    }

    const terraformRunner = new TerraformRunner();
    try {
      await terraformRunner.removeVmFromState(infraName);
    } catch (error: any) {
      logger.warn("Failed to clean Terraform state after proxmox_write destroy_vm", {
        vmName: infraName,
        error: error.message,
      });
    }

    try {
      const removed = await terraformRunner.removeVmFromTfvars(infraName);
      if (!removed) {
        logger.warn("Destroyed VM not present in tfvars during proxmox_write cleanup", {
          vmName: infraName,
        });
      }
    } catch (error: any) {
      logger.warn("Failed to clean tfvars after proxmox_write destroy_vm", {
        vmName: infraName,
        error: error.message,
      });
    }
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
  
  // Classify intent using probabilistic classifier
  const { classification, routing } = classifyAndRoute(userInput);
  const conversationPlan = planConversation({
    userInput: originalUserInput,
    intent: classification,
    routing,
    conversationState: options.conversationState,
    conversationContext: options.conversationContext,
    userPreferences: options.userPreferences,
    confirmation,
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
  
  // Store original classification for confidence monotonicity
  failureTracker.setOriginalClassification(userInput, classification);
  
  logger.info("Intent classification", {
    input: userInput.slice(0, 100),
    type: classification.type,
    confidence: classification.confidence,
    metadata: classification.metadata,
    route: routing.route,
    clarification_continuation: clarificationContinuation.usedContinuation,
    clarification_anchor: clarificationContinuation.anchorUserInput,
  });
  logger.info("Conversation transition", {
    conversation_state_before: options.conversationState ?? "IDLE",
    decision: conversationPlan.decision,
    confirmation_id: pendingActionId ?? null,
    pending_action_source: usedPendingAction ? "pending_replay" : "user_input",
  });

  const policyMode = options.userPreferences?.safeMode ? "safe" : "standard";
  const memoryUserName = options.conversationContext?.userName;
  const nameUpdate = extractUserNameUpdate(originalUserInput);
  if (!confirmation.confirmed && nameUpdate) {
    const text = `Got it. I'll call you ${nameUpdate}.`;
    const traceStore = getReasoningTraceStore();
    const traceStep: ReasoningStep = {
      step: 1,
      toolCalls: [],
      decisions: [
        {
          type: "retrieval_skipped",
          description: "Retrieval skipped for explicit identity update.",
          metadata: { reason: "meta_identity" },
        },
      ],
    };
    let traceId: string | undefined;
    try {
      traceId = await traceStore.recordTrace({
        userId: session.userId,
        aclGroup: session.aclGroup,
        userInput,
        finalResponse: text,
        steps: [traceStep],
        provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: responseMode }),
        totalSteps: 1,
        totalToolCalls: 0,
        maxStepsReached: false,
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
      });
    } catch (error: any) {
      logger.warn("Failed to record identity update trace", { error: error.message });
    }
    emitFinalEvent(text, {
      conversationState: "FOLLOWUP",
      conversationContext: { ...contextUpdate, userName: nameUpdate },
      memorySource: "user_explicit",
      memoryConfidence: 0.95,
      traceId,
    });
    return { text };
  }

  if (!confirmation.confirmed && isUserNameQuery(originalUserInput)) {
    const text = memoryUserName
      ? `Your name is ${memoryUserName}.`
      : "I don't have your name yet. Tell me with \"my name is <name>\".";
    const traceStore = getReasoningTraceStore();
    const traceStep: ReasoningStep = {
      step: 1,
      toolCalls: [],
      decisions: [
        {
          type: "retrieval_skipped",
          description: "Retrieval skipped for identity lookup.",
          metadata: { reason: "meta_identity" },
        },
      ],
    };
    let traceId: string | undefined;
    try {
      traceId = await traceStore.recordTrace({
        userId: session.userId,
        aclGroup: session.aclGroup,
        userInput,
        finalResponse: text,
        steps: [traceStep],
        provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: responseMode }),
        totalSteps: 1,
        totalToolCalls: 0,
        maxStepsReached: false,
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
      });
    } catch (error: any) {
      logger.warn("Failed to record identity lookup trace", { error: error.message });
    }
    emitFinalEvent(text, {
      conversationState: "FOLLOWUP",
      conversationContext: contextUpdate,
      traceId,
    });
    return { text };
  }

  if (!confirmation.confirmed && isAssistantNameQuery(originalUserInput)) {
    const text = `My name is ${ASSISTANT_NAME}.`;
    const traceStore = getReasoningTraceStore();
    const traceStep: ReasoningStep = {
      step: 1,
      toolCalls: [],
      decisions: [
        {
          type: "retrieval_skipped",
          description: "Retrieval skipped for assistant identity query.",
          metadata: { reason: "meta_identity" },
        },
      ],
    };
    let traceId: string | undefined;
    try {
      traceId = await traceStore.recordTrace({
        userId: session.userId,
        aclGroup: session.aclGroup,
        userInput,
        finalResponse: text,
        steps: [traceStep],
        provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: responseMode }),
        totalSteps: 1,
        totalToolCalls: 0,
        maxStepsReached: false,
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
      });
    } catch (error: any) {
      logger.warn("Failed to record assistant identity trace", { error: error.message });
    }
    emitFinalEvent(text, {
      conversationState: "FOLLOWUP",
      conversationContext: contextUpdate,
      traceId,
    });
    return { text };
  }

  // Fast-path social chat: do not run tools/LLM formatting pipeline.
  // This prevents "Answer/Evidence/Next steps" nonsense for greetings like "Hello".
  if (classification.intent === "CHAT_SOCIAL" && !confirmation.confirmed) {
    const text = "Hi — what do you want to check or change in your lab?";
    let traceId: string | undefined;
    try {
      const traceStore = getReasoningTraceStore();
      traceId = await traceStore.recordTrace({
        userId: session.userId,
        aclGroup: session.aclGroup,
        userInput,
        finalResponse: text,
        steps: [{
          step: 1,
          toolCalls: [],
          decisions: [{
            type: "retrieval_skipped",
            description: "Retrieval skipped for social greeting.",
            metadata: { reason: "chat_social" },
          }],
        }],
        provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: responseMode }),
        totalSteps: 1,
        totalToolCalls: 0,
        maxStepsReached: false,
        timestamp: new Date(),
        durationMs: Date.now() - startTime,
      });
    } catch (error: any) {
      logger.warn("Failed to record social trace", { error: error.message });
    }
    emitFinalEvent(text, {
      classification,
      conversationState: "FOLLOWUP",
      conversationContext: contextUpdate,
      traceId,
    });
    return { text };
  }

  // Fast-path subnet sizing questions (avoid falling into intent disambiguation).
  // Example: "i need a subnet for 128 hosts" → /24 (254 usable), /25 is only 126 usable.
  const subnetSizing = (() => {
    const q = (originalUserInput || "").toLowerCase();
    const match = q.match(/\bsubnet\b[\s\S]*?\b(\d+)\b[\s\S]*?\bhosts?\b/) || q.match(/\b(\d+)\b[\s\S]*?\bhosts?\b[\s\S]*?\bsubnet\b/);
    if (!match) return null;
    const hostsRaw = match[1];
    if (!hostsRaw) return null;
    const hosts = parseInt(hostsRaw, 10);
    if (!Number.isFinite(hosts) || hosts <= 0) return null;
    // IPv4: need 2 extra addresses for network+broadcast
    const needed = hosts + 2;
    let size = 1;
    while (size < needed) size *= 2;
    const prefix = 32 - Math.log2(size);
    const usable = Math.max(0, size - 2);
    // If exactly 128 was requested, call out /25 nuance explicitly.
    const note = hosts === 128
      ? "Note: /25 has 128 total addresses but only 126 usable host IPs; /24 is the smallest that supports 128 usable hosts."
      : undefined;
    return { hosts, prefix, usable, total: size, note };
  })();
  if (subnetSizing) {
    const text =
      `SubnetSizing | required_hosts=${subnetSizing.hosts} | smallest_ipv4_prefix=/${subnetSizing.prefix} | usable_hosts=${subnetSizing.usable} | total_addresses=${subnetSizing.total}` +
      (subnetSizing.note ? ` | note="${subnetSizing.note}"` : "");
    emitFinalEvent(text, {
      classification,
      conversationState: "FOLLOWUP",
      conversationContext: contextUpdate,
    });
    return { text };
  }

  // Handle high-risk confirmation gate (bound to pending action)
  if (conversationPlan.decision === "ASK_CONFIRM") {
    const pendingActionExecute = userInput;
    const pendingSummary = conversationPlan.pendingAction ?? pendingActionExecute;
    const pendingRecord = buildPendingActionRecord(
      pendingActionExecute,
      pendingSummary,
      `intent:${classification.intent.toLowerCase()}`
    );
    const confirmationPrompt =
      `Review pending change: ${pendingRecord.preview}\n` +
      `Reply with CONFIRM ${pendingRecord.id} to apply, or CANCEL.`;
    pceLogger.incrementCounter("confirmation_requested");
    logger.info("Conversation transition", {
      conversation_state_before: options.conversationState ?? "IDLE",
      decision: conversationPlan.decision,
      confirmation_id: pendingRecord.id,
      pending_action_source: "plan_conversation",
    });

    emitFinalEvent(confirmationPrompt, {
      confirmationRequired: true,
      confirmationId: pendingRecord.id,
      confirmationPreview: pendingRecord.preview,
      confirmationExpiresAt: pendingRecord.expiresAt,
      classification,
      conversationState: conversationPlan.nextState,
      pendingAction: pendingRecord.preview,
      conversationContext: {
        ...contextUpdate,
        pendingAction: pendingRecord.executeInput,
        pendingActionId: pendingRecord.id,
        pendingActionDigest: pendingRecord.digest,
        pendingActionCreatedAt: pendingRecord.createdAt,
        pendingActionSummary: pendingRecord.summary,
        pendingActionType: pendingRecord.type,
        pendingActionPreview: pendingRecord.preview,
        pendingActionExecuteInput: pendingRecord.executeInput,
        pendingActionExpiresAt: pendingRecord.expiresAt,
      },
    });
    return { text: confirmationPrompt };
  }

  // Handle clarification flow
  if (conversationPlan.decision === "ASK_CLARIFY") {
    // If we only know that the intent itself is ambiguous, ask for intent disambiguation
    // rather than calling ask_missing (which is slot-oriented).
    if (classification.missing.length === 1 && classification.missing[0] === "intent") {
      const disambiguation =
        "What do you want to do next — observe status, diagnose a problem, make a change, or get an explanation?";
      emitFinalEvent(disambiguation, {
        clarification: true,
        needsResponse: true,
        classification,
        conversationState: conversationPlan.nextState,
        conversationContext: contextUpdate,
      });
      return { text: disambiguation };
    }

    if (classification.missing.length > 0) {
      let clarificationQuestion = "Could you clarify the missing details?";
      try {
        const toolResult = await executeToolCall(
          {
            toolName: "ask_missing",
            parameters: {
              missing: classification.missing,
              intent: classification.intent,
              context: `Input: ${originalUserInput}`,
            },
          },
          tools,
          { userId: session.userId, aclGroup: session.aclGroup }
        );
        const question = (toolResult as any)?.data?.question;
        if (typeof question === "string" && question.trim().length > 0) {
          clarificationQuestion = question.trim();
        }
      } catch (error: any) {
        logger.warn("ask_missing tool failed, using fallback clarification", { error: error.message });
      }

      emitFinalEvent(clarificationQuestion, {
        clarification: true,
        needsResponse: true,
        classification,
        conversationState: conversationPlan.nextState,
        conversationContext: contextUpdate,
      });
      return { text: clarificationQuestion };
    }

    if (routing.route === "clarification") {
      const disambiguation =
        "Are you asking to observe, diagnose, change, explain, or plan? Please specify.";
      emitFinalEvent(disambiguation, {
        clarification: true,
        needsResponse: true,
        classification,
        conversationState: conversationPlan.nextState,
        conversationContext: contextUpdate,
      });
      return { text: disambiguation };
    }
  }
  
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
    
    const clarificationRetrievalDecisions: ReasoningStep["decisions"] = [];
    const clarificationRetrievalToolCalls: ReasoningStep["toolCalls"] = [];
    const clarificationRetrievalArtifacts: ReasoningTraceArtifactInput[] = [];
    let clarificationRagContextId: string | undefined;
    let clarificationGraphContextId: string | undefined;
    let clarificationFusionContextId: string | undefined;

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
      if (ragPayload) {
        const ragScore = ragPayload.sTotalScore ?? null;
        const domainMatch = hasDomainMatch(classification.metadata?.domain, ragPayload);
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
              mode: responseMode,
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
                    description: `Low confidence (${classification.confidence.toFixed(2)}) but RAG provided answer (score: ${ragPayload.sTotalScore?.toFixed(2)})`,
                    metadata: { classification, routing, ragScore: ragPayload.sTotalScore },
                  },
                ],
              }],
              provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: responseMode }),
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
          
          emitFinalEvent(cleanedAnswer, { 
            ragAnswer: true,
            ragScore: ragPayload.sTotalScore,
            classification,
            conversationState: postExecutionState,
            conversationContext: finalContextUpdate,
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
        domain: classification.metadata?.domain,
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
            description: `Confidence ${classification.confidence.toFixed(2)} below threshold for ${classification.type} intent`,
            metadata: { classification, routing },
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
        provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: responseMode }),
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
    
    emitFinalEvent(clarificationMessage, { 
      clarification: true, 
      needsResponse: true, 
      classification,
      conversationState: conversationPlan.nextState,
      conversationContext: contextUpdate,
      traceId: clarificationTraceId,
    });
    return { text: clarificationMessage };
  }

  // Check action intent FIRST (before ALL query intents)
  // This prevents action requests from being treated as queries
  const actionIntent = detectActionIntent(userInput);
  let resolvedVmContext: string | null = null;
  
  if (actionIntent) {
    logger.info("Detected action intent", { intent: actionIntent.type });

    // Deterministic fast-path: create VM requests must include a node; we already extracted it.
    // This avoids relying on the LLM to remember required action params (node is required by CreateVmSchema).
    if (actionIntent.type === "create_vm") {
      const node = (actionIntent as any).node as string | undefined;
      const name = (actionIntent as any).name as string | undefined;
      if (!node) {
        // Shouldn't happen (detectActionIntent requires node), but keep a safe fallback.
        const prompt = "Which node should I create the VM on? (e.g., yin, YANG, proxBig)";
        emitFinalEvent(prompt, {
          clarification: true,
          needsResponse: true,
          conversationState: "NEED_CLARIFICATION",
          conversationContext: contextUpdate,
        });
        return { text: prompt };
      }

      emitStepEvent({ step: 1, maxSteps: 1, userInput, intent: "create_vm", tool: "action" });

      const params: Record<string, any> = { node };
      if (name && name.trim().length > 0) params.name = name.trim();
      if (/\bdry\s*run\b/i.test(userInput) || /\bdryrun\b/i.test(userInput) || /\bpreview\b/i.test(userInput) || /\bplan\b/i.test(userInput)) {
        params.dryRun = true;
      }
      if (options.getProfilePublicKey && session.userId) {
        const profileKey = options.getProfilePublicKey(session.userId);
        if (profileKey && profileKey.trim().length > 0) params.sshPublicKey = profileKey.trim();
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
        { userId: session.userId, aclGroup: session.aclGroup }
      );

      const data = (result as any)?.data;
      const ok = (result as any)?.success === true || data?.success === true;
      const message = data?.message || (result as any)?.message || (result as any)?.error || "Action completed.";
      const vmId = data?.vmId || data?.vmid || data?.id;
      const hostname = data?.hostname || data?.name;

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
          provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: responseMode }),
          totalSteps: 1,
          totalToolCalls: 1,
          maxStepsReached: false,
          timestamp: new Date(),
          durationMs,
        });
      } catch (error: any) {
        logger.warn("Failed to record reasoning trace for create_vm", { error: error.message });
      }

      emitFinalEvent(text, {
        classification,
        conversationState: postExecutionState,
        conversationContext: finalContextUpdate,
        traceId: createVmTraceId,
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
        emitFinalEvent(prompt, {
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
          emitFinalEvent(prompt, {
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
        emitFinalEvent(prompt, {
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
        emitFinalEvent(prompt, {
          clarification: true,
          needsResponse: true,
          conversationState: "NEED_CLARIFICATION",
          conversationContext: contextUpdate,
        });
        return { text: prompt };
      }

      emitStepEvent({ step: 1, maxSteps: 1, userInput, intent: "destroy_vm", tool: "action" });

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
          provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: responseMode }),
          totalSteps: 1,
          totalToolCalls: 1,
          maxStepsReached: false,
          timestamp: new Date(),
          durationMs,
        });
      } catch (error: any) {
        logger.warn("Failed to record reasoning trace for destroy_vm", { error: error.message });
      }

      emitFinalEvent(text, {
        classification,
        conversationState: postExecutionState,
        conversationContext: finalContextUpdate,
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
  } else {
    // Only check query intents if no action intent was detected
    // Check exposure intent first (most specific)
    const exposureIntent = detectExposureIntent(userInput);
    if (exposureIntent) {
      const exposureAnswer = await executeExposureIntent(exposureIntent, tools, session);
      if (exposureAnswer) {
        logger.info("Responding via twin-first exposure reasoning chain.");
        emitStepEvent({ step: 1, maxSteps: 1, intent: exposureIntent.type, mode: "twin_first", tool: "twin_query" });
        
        // Format exposure response for bot-like style
        let formattedAnswer = exposureAnswer;
        try {
          formattedAnswer = await formatResponseForBot(exposureAnswer, {
            userQuery: userInput,
            intentType: "exposure_analysis",
            toolCalls: [{ toolName: "twin_query", parameters: { operation: exposureIntent.type } }],
            mode: responseMode,
          });
        } catch (error: any) {
          logger.warn("Failed to format exposure answer", { error: error.message });
        }
        
        const traceId = await recordEarlyReturnTrace(formattedAnswer, exposureIntent.type, 1);
        emitFinalEvent(formattedAnswer, { 
          intent: exposureIntent.type,
          traceId,
          conversationState: postExecutionState,
          conversationContext: finalContextUpdate,
        });
        return { text: formattedAnswer };
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
        emitStepEvent({ step: 1, maxSteps: 1, intent: computeIntent.type, mode: "twin_first", tool: "twin_query" });
        
        // Format compute response for bot-like style
        let formattedAnswer = twinAnswer;
        try {
          formattedAnswer = await formatResponseForBot(twinAnswer, {
            userQuery: userInput,
            intentType: "compute_status",
            toolCalls: [{ toolName: "twin_query", parameters: { operation: computeIntent.type } }],
            mode: responseMode,
          });
        } catch (error: any) {
          logger.warn("Failed to format compute answer", { error: error.message });
        }
        
        const traceId = await recordEarlyReturnTrace(formattedAnswer, computeIntent.type, 1);
        emitFinalEvent(formattedAnswer, { 
          intent: computeIntent.type,
          traceId,
          conversationState: postExecutionState,
          conversationContext: finalContextUpdate,
        });
        return { text: formattedAnswer };
      }
    }

    // Check firewall QUERY intent (only if no action intent detected)
    // Action intents like "configure firewall" are handled above
    const firewallIntent = detectFirewallIntent(userInput);
    if (firewallIntent) {
      const firewallAnswer = await executeFirewallIntent(firewallIntent, tools, session);
      if (firewallAnswer) {
        logger.info("Responding via twin-first firewall reasoning chain.");
        emitStepEvent({ step: 1, maxSteps: 1, intent: firewallIntent.type, mode: "twin_first", tool: "twin_query" });
        const firewallToolCalls = buildFirewallToolCalls(firewallIntent);
        
        // Format firewall response for bot-like style
        let formattedAnswer = firewallAnswer;
        try {
          formattedAnswer = await formatResponseForBot(firewallAnswer, {
            userQuery: userInput,
            intentType: "firewall_rules",
            toolCalls: firewallToolCalls,
            mode: responseMode,
          });
        } catch (error: any) {
          logger.warn("Failed to format firewall answer", { error: error.message });
        }
        
        const traceId = await recordEarlyReturnTrace(
          formattedAnswer,
          firewallIntent.type,
          firewallToolCalls.length,
          firewallToolCalls
        );
        emitFinalEvent(formattedAnswer, { 
          intent: firewallIntent.type,
          traceId,
          conversationState: postExecutionState,
          conversationContext: finalContextUpdate,
        });
        return { text: formattedAnswer };
      }
    }
    // Only check network intent if no action, exposure, compute, or firewall intent was detected
    const networkIntent = detectNetworkIntent(userInput);
    if (networkIntent) {
      const networkAnswer = await executeNetworkIntent(networkIntent, tools, session);
      if (networkAnswer) {
        logger.info("Responding via twin-first network reasoning chain.");
        emitStepEvent({ step: 1, maxSteps: 1, intent: networkIntent.type, mode: "twin_first", tool: "twin_query" });
        
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
          formattedAnswer = await formatResponseForBot(networkAnswer, {
            userQuery: userInput,
            intentType: "network_info",
            toolCalls,
            mode: responseMode,
          });
        } catch (error: any) {
          logger.warn("Failed to format network answer", { error: error.message });
        }
        
        const traceId = await recordEarlyReturnTrace(formattedAnswer, networkIntent.type, 1);
        emitFinalEvent(formattedAnswer, { 
          intent: networkIntent.type,
          traceId,
          conversationState: postExecutionState,
          conversationContext: finalContextUpdate,
        });
        return { text: formattedAnswer };
      }
    }
  }

  const openaiTools = buildToolDefinitions(tools);
  
  // Initialize reasoning trace
  const reasoningSteps: ReasoningStep[] = [];
  let totalToolCalls = 0;
  
  // Determine retrieval eligibility before hitting RAG/graph/fusion.
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
  const isMetaQuery = isMetaIdentityQuery(userInput);
  const eligibility = getRetrievalEligibility({
    intent: classification.intent,
    isTrivialQuery: isTrivialQuery(userInput),
    isActionIntent: !!actionIntent,
    isRealTimeMetricQuery,
    isMetaIdentityQuery: isMetaQuery,
  });

  if (isRealTimeMetricQuery) {
    logger.info("Skipping RAG for real-time metric query - will use tools instead", {
      query: userInput.slice(0, 100),
    });
  }

  let ragPayload: HybridApiContext | null = null;
  let retrievalInjected = false;
  let retrievalInjectedReason = "not_executed";
  let retrievalDomainMatch = true;
  let ragContextId: string | undefined;
  let graphContextId: string | undefined;
  let fusionContextId: string | undefined;
  let retrievalToolCalls: ReasoningStep["toolCalls"] = [];
  let retrievalArtifacts: ReasoningTraceArtifactInput[] = [];
  const retrievalDecisions: ReasoningStep["decisions"] = [];

  if (!eligibility.eligible) {
    retrievalDecisions.push({
      type: "retrieval_skipped",
      description: "Retrieval skipped before execution.",
      metadata: { reason: eligibility.reason },
    });
    logger.info("RAG retrieval skipped", { reason: eligibility.reason, query: userInput.slice(0, 80) });
  } else {
    ragPayload = await fetchHybridContext(userInput, {
      baseUrl: options.ragBaseUrl,
      userId: session.userId,
      aclGroup: session.aclGroup,
    });
    if (ragPayload) {
      retrievalDecisions.push({
        type: "retrieval_executed",
        description: "Retrieval executed for eligible query.",
        metadata: {
          queryType: ragPayload.queryType,
          score: ragPayload.sTotalScore ?? null,
          sourcesCount: ragPayload.sources?.length ?? 0,
        },
      });
      retrievalDomainMatch = hasDomainMatch(classification.metadata?.domain, ragPayload);
      const score = ragPayload.sTotalScore ?? null;
      const hasSources = (ragPayload.sources?.length ?? 0) > 0;
      if (!hasSources) {
        retrievalInjectedReason = "no_sources";
      } else if (score === null || score < RETRIEVAL_MIN_SCORE) {
        retrievalInjectedReason = "score_below_threshold";
      } else if (!retrievalDomainMatch) {
        retrievalInjectedReason = "domain_mismatch";
      } else {
        retrievalInjectedReason = "accepted";
        retrievalInjected = true;
      }
      retrievalDecisions.push({
        type: retrievalInjected ? "retrieval_injected" : "retrieval_not_injected",
        description: retrievalInjected
          ? "Retrieval injected into prompt."
          : "Retrieval executed but not injected into prompt.",
        metadata: {
          score,
          minScore: RETRIEVAL_MIN_SCORE,
          domainMatch: retrievalDomainMatch,
          sourcesCount: ragPayload.sources?.length ?? 0,
          reason: retrievalInjectedReason,
        },
      });
      const artifactBundle = buildRetrievalArtifacts(ragPayload);
      retrievalArtifacts = artifactBundle.artifacts;
      ragContextId = artifactBundle.ragContextId;
      graphContextId = artifactBundle.graphContextId;
      fusionContextId = artifactBundle.fusionContextId;
      retrievalToolCalls = buildRetrievalToolCalls(ragPayload);
      logger.info("RAG retrieval executed", {
        injected: retrievalInjected,
        reason: retrievalInjectedReason,
        hasCandidateAnswer: !!(ragPayload.answer?.trim()),
        candidateAnswerLength: ragPayload.answer?.length ?? 0,
        query: userInput.slice(0, 80),
      });
    } else {
      retrievalInjected = false;
      retrievalInjectedReason = "unavailable";
      retrievalDecisions.push({
        type: "retrieval_not_injected",
        description: "Retrieval request failed or returned no payload.",
        metadata: { reason: "unavailable" },
      });
      logger.info("RAG retrieval unavailable", { query: userInput.slice(0, 80) });
    }
  }

  const ragMessage = retrievalInjected && ragPayload
    ? [{ role: "system", content: formatRagSummary(ragPayload) }]
    : [];
  
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

  let confirmationAbort: { prompt: string; context: ConversationContext; state: ConversationState } | null = null;
  let clarificationAbort: { prompt: string; context: ConversationContext; state: ConversationState } | null = null;

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

    // Attach retrieval decisions + artifact references on step 1.
    if (step === 0) {
      if (retrievalDecisions.length > 0) {
        reasoningStep.decisions.push(...retrievalDecisions);
      }
      if (retrievalToolCalls.length > 0) {
        reasoningStep.toolCalls.push(...retrievalToolCalls);
        totalToolCalls += retrievalToolCalls.length;
      }
      if (ragContextId) reasoningStep.ragContextId = ragContextId;
      if (graphContextId) reasoningStep.graphContextId = graphContextId;
      if (fusionContextId) reasoningStep.fusionContextId = fusionContextId;
    }

    // Build messages array with optional resolved VM context
    const vmContextMessage = resolvedVmContext ? [
      { role: "system", content: resolvedVmContext }
    ] : [];
  const memoryContext = buildConversationMemoryPrompt(options.conversationContext);
  const memoryContextMessage = memoryContext ? [
    { role: "system", content: memoryContext }
  ] : [];
    
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
    ...memoryContextMessage,
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
        // For twin_query with node_temperature, allow different nodeName params (not duplicates)
        const isTemperatureQuery = toolName === "twin_query" && parsedArgs.operation === "node_temperature";
        const callSignature = isTemperatureQuery
          ? `${toolName}:${parsedArgs.operation}:${parsedArgs.params?.nodeName || "all"}`
          : `${toolName}:${JSON.stringify(parsedArgs, Object.keys(parsedArgs).sort())}`;
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

        const toolRisk = mapToolRiskToIntentRisk(getToolRisk(targetTool));
        const derivedRisk = deriveToolCallRisk(toolName, parsedArgs);
        const effectiveRisk = maxRisk(classification.risk, toolRisk, derivedRisk ?? "READ");
        const needsToolConfirmation = effectiveRisk === "WRITE_HIGH" || effectiveRisk === "DESTRUCTIVE";
        const requiresApproval = requiresConfirmation(targetTool) || needsToolConfirmation;
        const explicitConfirmationOk =
          confirmation.confirmed &&
          !!pendingActionId &&
          confirmation.actionId === pendingActionId &&
          !pendingActionExpired;

        const missingToolSlots = inferMissingToolSlots(toolName, parsedArgs);
        if (missingToolSlots.length > 0) {
          let clarificationQuestion = "Could you clarify the missing details?";
          try {
            const askMissingResult = await executeToolCall(
              {
                toolName: "ask_missing",
                parameters: {
                  missing: missingToolSlots,
                  intent: "ACTION",
                  context: `Tool call: ${toolName} ${JSON.stringify(parsedArgs)}`,
                },
              },
              tools,
              { userId: session.userId, aclGroup: session.aclGroup }
            );
            const question = (askMissingResult as any)?.data?.question;
            if (typeof question === "string" && question.trim().length > 0) {
              clarificationQuestion = question.trim();
            }
          } catch (error: any) {
            logger.warn("ask_missing failed during tool pre-validation", { error: error.message, toolName });
          }

          const shouldResetPendingContext =
            usedPendingAction ||
            (confirmation.confirmed && !!pendingActionId && confirmation.actionId === pendingActionId);
          clarificationAbort = {
            prompt: clarificationQuestion,
            state: "NEED_CLARIFICATION",
            context: shouldResetPendingContext
              ? {
                  pendingAction: "",
                  pendingActionId: "",
                  pendingActionDigest: "",
                  pendingActionCreatedAt: 0,
                  pendingActionSummary: "",
                  pendingActionType: "",
                  pendingActionPreview: "",
                  pendingActionExecuteInput: "",
                  pendingActionExpiresAt: 0,
                }
              : {},
          };
          reasoningStep.decisions.push({
            type: "validation_failed",
            description: "Tool execution blocked until required action details are provided",
            metadata: { toolName, missing: missingToolSlots },
          });
          break;
        }

        if (requiresApproval && !explicitConfirmationOk) {
          const summary = summarizeToolCall(toolName, parsedArgs);
          const existingId = pendingActionId;
          const pendingRecord = existingId
            ? {
                id: existingId,
                digest: options.conversationContext?.pendingActionDigest ?? "",
                createdAt: pendingActionCreatedAt ?? Date.now(),
                expiresAt: pendingActionExpiresAt ?? (Date.now() + 15 * 60 * 1000),
                type: options.conversationContext?.pendingActionType ?? `tool:${toolName}`,
                preview: pendingActionPreview ?? pendingActionSummary ?? summary,
                executeInput: pendingActionExecuteInput ?? pendingAction ?? userInput,
                summary: pendingActionSummary ?? pendingActionPreview ?? summary,
              }
            : buildPendingActionRecord(
                userInput,
                summary,
                `tool:${toolName}`
              );
          const prompt =
            `Review pending change: ${pendingRecord.preview}\n` +
            `Reply with CONFIRM ${pendingRecord.id} to apply, or CANCEL.`;

          confirmationAbort = {
            prompt,
            state: "AWAITING_CONFIRMATION",
            context: {
              pendingAction: pendingRecord.executeInput,
              pendingActionId: pendingRecord.id,
              pendingActionDigest: pendingRecord.digest,
              pendingActionCreatedAt: pendingRecord.createdAt,
              pendingActionSummary: pendingRecord.summary,
              pendingActionType: pendingRecord.type,
              pendingActionPreview: pendingRecord.preview,
              pendingActionExecuteInput: pendingRecord.executeInput,
              pendingActionExpiresAt: pendingRecord.expiresAt,
            },
          };
          pceLogger.incrementCounter("confirmation_requested");
          logger.info("Conversation transition", {
            conversation_state_before: options.conversationState ?? "IDLE",
            decision: "ASK_CONFIRM",
            confirmation_id: pendingRecord.id,
            pending_action_source: existingId ? "existing_pending_action" : "tool_guard",
          });
          reasoningStep.decisions.push({
            type: "validation_failed",
            description: "Tool execution blocked pending explicit confirmation",
            metadata: { toolName, effectiveRisk },
          });
          break;
        }

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
            // Execute the actual operation
            result = await executeToolCall(
              { toolName, parameters: parsedArgs },
              tools,
              execContext
            );
          }
        } else {
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
          if (
            toolName === "proxmox_write" &&
            parsedArgs.action === "destroy_vm" &&
            parsedArgs.dryRun !== true &&
            (result.data as any)?.status === "destroyed"
          ) {
            const destroyedVmName = (result.data as any)?.vmName;
            if (typeof destroyedVmName === "string" && destroyedVmName.trim().length > 0) {
              await cleanupAfterProxmoxDestroy(destroyedVmName);
            } else {
              logger.warn("Skipping Terraform cleanup for proxmox_write destroy_vm due to missing vmName", {
                node: parsedArgs.node,
                vmid: parsedArgs.vmid,
              });
            }
          }

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

      if (clarificationAbort) {
        const mergedContext: ConversationContext = {
          ...contextUpdate,
          ...clarificationAbort.context,
        };
        emitFinalEvent(clarificationAbort.prompt, {
          clarification: true,
          needsResponse: true,
          classification,
          conversationState: clarificationAbort.state,
          conversationContext: mergedContext,
        });
        return { text: clarificationAbort.prompt };
      }

      if (confirmationAbort) {
        const mergedContext: ConversationContext = {
          ...contextUpdate,
          ...confirmationAbort.context,
        };
        emitFinalEvent(confirmationAbort.prompt, {
          confirmationRequired: true,
          confirmationId: mergedContext.pendingActionId,
          confirmationPreview: mergedContext.pendingActionPreview ?? mergedContext.pendingActionSummary,
          confirmationExpiresAt: mergedContext.pendingActionExpiresAt ?? 0,
          classification,
          conversationState: confirmationAbort.state,
          conversationContext: mergedContext,
        });
        return { text: confirmationAbort.prompt };
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

    let finalText = coerceTextContent(message?.content).trim();
    if (finalText) {
      const shouldPreserveClarificationQuestion =
        classification.intent === "ACTION" &&
        reasoningStep.toolCalls.length === 0 &&
        /\?\s*$/.test(finalText);
      const shouldPreserveConfirmationPrompt =
        /^Review pending change:\s*/i.test(finalText) &&
        /Reply with CONFIRM\s+[a-z0-9_-]+\s+to apply,\s+or\s+CANCEL\.?/i.test(finalText);
      const shouldBypassFormatting = shouldPreserveClarificationQuestion || shouldPreserveConfirmationPrompt;

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
      
      if (!shouldBypassFormatting) {
        // Format response for bot-like style before returning
        try {
          // Extract tool calls from reasoning steps for context
          const allToolCalls = reasoningSteps.flatMap(step => 
            step.toolCalls.map(tc => ({
              toolName: tc.toolName,
              parameters: tc.parameters,
            }))
          );
          
          const intentType = detectResponseIntent(userInput, allToolCalls);
          let enrichedText = finalText;
          if (responseMode === "ASSISTIVE" || responseMode === "EXPLAINER") {
            const movesContext = await buildBotMoveContext(finalText, classification.intent);
            if (movesContext) {
              enrichedText = `${movesContext}\n\n${finalText}`;
            }
          }
          finalText = await formatResponseForBot(enrichedText, {
            userQuery: userInput,
            intentType,
            toolCalls: allToolCalls,
            mode: responseMode,
          });
        } catch (error: any) {
          logger.warn("Failed to format final response", { error: error.message });
          // Continue with unformatted response
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
          provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: responseMode }),
          artifacts: retrievalArtifacts,
          totalSteps: reasoningSteps.length,
          totalToolCalls,
          maxStepsReached: false,
          timestamp: new Date(),
          durationMs: Date.now() - startTime,
        });
      } catch (error: any) {
        logger.warn("Failed to record reasoning trace", { error: error.message });
      }
      
      // Synthesis marker: log possible RAG underuse when CandidateAnswer was provided but reply may not use it
      if (retrievalInjected && ragPayload?.answer?.trim() && finalText) {
        const candidate = ragPayload.answer.trim();
        const reply = finalText.trim();
        const minLen = Math.min(30, Math.floor(candidate.length / 2));
        if (minLen >= 15) {
          const candidateNorm = candidate.toLowerCase().replace(/\s+/g, " ");
          const replyNorm = reply.toLowerCase().replace(/\s+/g, " ");
          let found = false;
          for (let i = 0; i <= candidateNorm.length - minLen && !found; i++) {
            const slice = candidateNorm.slice(i, i + minLen);
            if (replyNorm.includes(slice)) found = true;
          }
          if (!found) {
            logger.info("Possible RAG underuse: reply may not incorporate CandidateAnswer", {
              candidateAnswerLength: candidate.length,
              replyLength: reply.length,
              query: userInput.slice(0, 80),
            });
          }
        }
      }

      // Emit agent:final event with trace ID
      const durationMs = Date.now() - startTime;
      emitFinalEvent(finalText, { 
        totalSteps: step + 1,
        totalToolCalls,
        traceId,
        conversationState: shouldPreserveClarificationQuestion
          ? "NEED_CLARIFICATION"
          : shouldPreserveConfirmationPrompt
            ? "AWAITING_CONFIRMATION"
            : postExecutionState,
        conversationContext: finalContextUpdate,
        clarification: shouldPreserveClarificationQuestion,
        needsResponse: shouldPreserveClarificationQuestion || shouldPreserveConfirmationPrompt,
      });
      
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
      provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: responseMode }),
      artifacts: retrievalArtifacts,
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
    traceId,
    conversationState: conversationPlan.nextState,
    conversationContext: contextUpdate,
  });

  return { text: "Max reasoning depth reached. Please try a simpler query." };
}
