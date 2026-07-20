/**
 * Execute path handler: RAG → LLM loop → tool dispatch → reclassification.
 * Extracted from runner.ts to keep runAgent() as a thin coordinator.
 */

import OpenAI from "openai";
import { generateObject } from "ai";
import { openai as aiSdkOpenai } from "@ai-sdk/openai";
import type { ExecutionResult } from "../../types/execution";
import type { ConversationContext } from "../../types";
import { logger } from "../../utils/logger";
import { executeToolCall } from "../tool-executor";
import type { AgentContext } from "../context";
import { buildSystemPrompt, buildStructuredResponsePrompt } from "../system-prompt";
import { AgentResponseSchema, type AgentResponse } from "../schemas/agent-response";
import { fetchHybridContext, type HybridApiContext } from "../rag-client";
import { getToolRisk, isToolAuthorized, requiresConfirmation, type ToolSession } from "../tool-policy";
import { sanitizeToolPayload } from "../tool-sanitizer";
import {
  getReasoningTraceStore,
  type ReasoningStep,
  type ReasoningTraceArtifactInput,
} from "../../pce/api/reasoning-trace-store";
import type { AgentEventBus } from "../event-bus";
import type { BaseTool } from "../../tools/BaseTool";
import { getRetrievalEligibility } from "../retrieval-eligibility";
import { reclassifyIntentWithContext, FailureTracker, type FailureContext } from "../../reasoning/failure-reclassification";
import { classifyIntentWithLLM } from "../../reasoning/intent-router";
import { detectFirewallIntent } from "../../reasoning/detectFirewallIntent";
import { formatAliasContentsPayload } from "../../reasoning/chains/firewall";
import type { ActionIntent } from "../../reasoning/action-intents";
import { pceLogger } from "../../pce/utils/logger";
import type { AgentStateV1, AgentRunOptions } from "../state";
import type { ConfirmationParseResult } from "../dialog-policy";
import { deriveToolCallRisk, mapToolRiskToIntentRisk, maxRisk } from "../tool-risk";
import { applyAdaptivePackaging } from "../response-formatter";
import {
  buildToolDefinitions,
  buildProvenance,
  buildRetrievalArtifacts,
  buildRetrievalToolCalls,
  coerceTextContent,
  hasDomainMatch,
  buildConversationMemoryPrompt,
  RETRIEVAL_MIN_SCORE,
  COMPOSITE_MULTI_STEP_INSTRUCTION,
  formatRagSummary,
  getOpenAIClient,
} from "../runner";
import { emitFinalEvent, emitStepEvent } from "./emit-helpers";
import { parseToolArgs } from "./parse-tool-args";
import {
  buildPendingActionRecord,
  summarizeToolCall,
  inferMissingToolSlots,
  cleanupAfterProxmoxDestroy,
} from "./tool-helpers";
import { isMetaIdentityQuery } from "./identity-helpers";
import { generateActionPlan } from "./plan-generator";
import {
  extractResolvedVmEntity,
  hydrateProxmoxReadArgs,
  type ResolvedVmEntity,
} from "./tool-argument-hydration";
import {
  detectVmProvenanceIntent,
  formatVmProvenanceAnswer,
} from "../vm-provenance";

export interface HandleExecuteInput {
  state: AgentStateV1;
  userInput: string;
  session: ToolSession;
  options: AgentRunOptions;
  tools: BaseTool[];
  context: AgentContext;
  eventBus: AgentEventBus;
  sessionId: string;
  startTime: number;
  policyMode: string;
  toolRegistryVersion: string;
  failureTracker: FailureTracker;
  actionIntent: ActionIntent | null;
  resolvedVmContext: string | null;
  isCompositeQuery: boolean;
  confirmation: ConfirmationParseResult;
  pendingActionId: string | undefined;
  pendingActionCreatedAt: number | undefined;
  pendingActionExpiresAt: number | undefined;
  pendingActionExpired: boolean;
  pendingActionPreview: string | undefined;
  pendingActionSummary: string | undefined;
  pendingActionExecuteInput: string | undefined;
  pendingAction: string | undefined;
  usedPendingAction: boolean;
  entityCache?: Record<string, string>;
}

export async function handleExecute(
  input: HandleExecuteInput
): Promise<{ text: string; entityCacheUpdate?: Record<string, string> }> {
  const {
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
    entityCache,
  } = input;

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

  const openaiTools = buildToolDefinitions(tools);

  // Initialize reasoning trace
  const reasoningSteps: ReasoningStep[] = [];
  let totalToolCalls = 0;
  let resolvedVmEntity: ResolvedVmEntity | null = null;

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
    /\b(how\s+many\s+).*\b(uptime|running|up)\b/i,
    /\b(uptime|running)\s+(higher|greater|more|over|>\s*)\s*(\d+)\s*(days?|hours?)/i,
    /\b(uptime\s+>\s*\d+|\d+\s*\+\s*days?\s+uptime)/i,
  ];

  const isRealTimeMetricQuery = realTimeMetricPatterns.some(pattern => pattern.test(userInput));
  const isMetaQuery = isMetaIdentityQuery(userInput);
  const eligibility = getRetrievalEligibility({
    intent: state.classification.intent,
    domain: state.classification.metadata?.domain,
    isTrivialQuery: isTrivialQuery(userInput),
    isActionIntent: !!actionIntent,
    isRealTimeMetricQuery,
    isMetaIdentityQuery: isMetaQuery,
    isCompositeQuery,
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

  const normalizeAliasLookupName = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9]/g, "");

  const findAliasRow = (aliases: any[], aliasName: string): any | null => {
    const requested = normalizeAliasLookupName(aliasName);
    if (!requested) return null;
    return aliases.find((alias) => {
      const name = typeof alias?.name === "string" ? alias.name : "";
      const uuid = typeof alias?.uuid === "string" ? alias.uuid : "";
      return normalizeAliasLookupName(name) === requested || normalizeAliasLookupName(uuid) === requested;
    }) ?? null;
  };

  const appendToolTrace = (
    step: ReasoningStep,
    toolName: string,
    parameters: Record<string, any>,
    result: ExecutionResult
  ) => {
    const dataPreview = result.data && typeof result.data === "object"
      ? JSON.stringify(result.data).slice(0, 500)
      : String(result.data || "").slice(0, 500);
    const dataSize = result.data && typeof result.data === "object"
      ? JSON.stringify(result.data).length
      : String(result.data || "").length;
    const resultType = result.data
      ? (Array.isArray(result.data) ? "array" : typeof result.data)
      : undefined;
    step.toolCalls.push({
      toolName,
      parameters,
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
  };

  const vmProvenanceIntent = detectVmProvenanceIntent(userInput);
  if (vmProvenanceIntent) {
    const reasoningStep: ReasoningStep = {
      step: 1,
      toolCalls: [],
      decisions: [
        {
          type: "tool_choice",
          description: "Selected deterministic VM provenance and change-history path",
          metadata: {
            intent: "vm_provenance",
            vmName: vmProvenanceIntent.vmName,
          },
        },
      ],
      llmResponse: "",
    };

    const resolveParams = {
      operation: "find_vm_by_name",
      params: { vmName: vmProvenanceIntent.vmName },
    };
    const resolveResult = await executeToolCall(
      { toolName: "twin_query", parameters: resolveParams },
      tools,
      { userId: session.userId, aclGroup: session.aclGroup }
    );
    appendToolTrace(reasoningStep, "twin_query", resolveParams, resolveResult);
    const resolution = resolveResult.error
      ? null
      : extractResolvedVmEntity("twin_query", resolveResult.data);

    let finalText: string;
    if (!resolution) {
      finalText = resolveResult.error
        ? `Unable to resolve ${vmProvenanceIntent.vmName}: ${resolveResult.error}`
        : `No unique VM or container named ${vmProvenanceIntent.vmName} was found.`;
    } else {
      const configParams = {
        action: "get_vm_config",
        node: resolution.node,
        vmid: resolution.vmid,
        ...(resolution.type ? { type: resolution.type } : {}),
      };
      const taskParams = {
        action: "node_tasks",
        node: resolution.node,
        vmid: resolution.vmid,
      };
      const [configResult, taskResult] = await Promise.all([
        executeToolCall(
          { toolName: "proxmox_readonly", parameters: configParams },
          tools,
          {
            userId: session.userId,
            aclGroup: session.aclGroup,
            node: resolution.node,
            vmid: resolution.vmid,
          }
        ),
        executeToolCall(
          { toolName: "proxmox_readonly", parameters: taskParams },
          tools,
          {
            userId: session.userId,
            aclGroup: session.aclGroup,
            node: resolution.node,
            vmid: resolution.vmid,
          }
        ),
      ]);
      appendToolTrace(reasoningStep, "proxmox_readonly", configParams, configResult);
      appendToolTrace(reasoningStep, "proxmox_readonly", taskParams, taskResult);
      finalText = formatVmProvenanceAnswer({
        resolution,
        configData: configResult.error
          ? undefined
          : configResult.data as Record<string, any>,
        configError: configResult.error,
        tasksData: taskResult.error
          ? undefined
          : taskResult.data as Record<string, any>,
        tasksError: taskResult.error,
      });
    }

    reasoningStep.llmResponse = finalText;
    reasoningSteps.push(reasoningStep);
    const durationMs = Date.now() - startTime;
    let traceId: string | undefined;
    try {
      traceId = await getReasoningTraceStore().recordTrace({
        userId: session.userId,
        aclGroup: session.aclGroup,
        userInput,
        finalResponse: finalText,
        steps: reasoningSteps,
        provenance: buildProvenance({
          toolRegistryVersion,
          policyMode,
          selectedMode: state.responseMode,
        }),
        artifacts: [],
        totalSteps: reasoningSteps.length,
        totalToolCalls,
        maxStepsReached: false,
        timestamp: new Date(),
        durationMs,
      });
    } catch (error: any) {
      logger.warn("Failed to record VM provenance reasoning trace", {
        error: error.message,
      });
    }

    emitFinalEvent(eventBus, sessionId, startTime, finalText, {
      totalSteps: reasoningSteps.length,
      totalToolCalls,
      traceId,
      conversationState: state.postExecutionState,
      conversationContext: state.finalContextUpdate,
    });
    return { text: finalText, entityCacheUpdate: {} };
  }

  const aliasIntent = detectFirewallIntent(userInput);
  if (aliasIntent?.type === "alias_contents") {
    const reasoningStep: ReasoningStep = {
      step: 1,
      toolCalls: [],
      decisions: [
        {
          type: "tool_choice",
          description: "Selected deterministic firewall alias content path",
          metadata: { intent: aliasIntent.type, aliasName: aliasIntent.aliasName },
        },
      ],
      llmResponse: "",
    };

    let aliasPayload: any | null = null;
    const getParams = { action: "firewall_aliases_get", alias_name: aliasIntent.aliasName };
    const getResult = await executeToolCall(
      { toolName: "opnsense_readonly", parameters: getParams },
      tools,
      { userId: session.userId, aclGroup: session.aclGroup }
    );
    appendToolTrace(reasoningStep, "opnsense_readonly", getParams, getResult);

    if (!getResult.error) {
      aliasPayload = getResult.data;
    } else {
      reasoningStep.decisions.push({
        type: "failure_reclassification",
        description: `Alias get failed: ${getResult.error}. Falling back to firewall_aliases_list exact-name lookup.`,
        metadata: { toolName: "opnsense_readonly", error: getResult.error, fallback: "firewall_aliases_list" },
      });
      const listParams = { action: "firewall_aliases_list" };
      const listResult = await executeToolCall(
        { toolName: "opnsense_readonly", parameters: listParams },
        tools,
        { userId: session.userId, aclGroup: session.aclGroup }
      );
      appendToolTrace(reasoningStep, "opnsense_readonly", listParams, listResult);
      if (!listResult.error) {
        const aliases = Array.isArray((listResult.data as any)?.aliases) ? (listResult.data as any).aliases : [];
        const matchedAlias = findAliasRow(aliases, aliasIntent.aliasName);
        if (matchedAlias) {
          aliasPayload = {
            action: "firewall_aliases_get",
            alias_name: aliasIntent.aliasName,
            resolved_alias_name: matchedAlias.name ?? aliasIntent.aliasName,
            data: matchedAlias,
            source: "firewall_aliases_list",
            timestamp: new Date().toISOString(),
          };
        }
      }
    }

    const rawAnswer = aliasPayload
      ? formatAliasContentsPayload(aliasIntent.aliasName, aliasPayload)
      : `Answer: No. No alias named \`${aliasIntent.aliasName}\` was found in the current firewall alias list.`;
    const finalText = applyAdaptivePackaging(rawAnswer, {
      userQuery: userInput,
      intentType: "firewall_rules",
      mode: state.responseMode,
    }) ?? rawAnswer;
    reasoningStep.llmResponse = finalText;
    reasoningSteps.push(reasoningStep);

    const durationMs = Date.now() - startTime;
    let traceId: string | undefined;
    try {
      const traceStore = getReasoningTraceStore();
      traceId = await traceStore.recordTrace({
        userId: session.userId,
        aclGroup: session.aclGroup,
        userInput,
        finalResponse: finalText,
        steps: reasoningSteps,
        provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: state.responseMode }),
        artifacts: retrievalArtifacts,
        totalSteps: reasoningSteps.length,
        totalToolCalls,
        maxStepsReached: false,
        timestamp: new Date(),
        durationMs,
      });
    } catch (error: any) {
      logger.warn("Failed to record alias reasoning trace", { error: error.message });
    }

    emitFinalEvent(eventBus, sessionId, startTime, finalText, {
      totalSteps: reasoningSteps.length,
      totalToolCalls,
      traceId,
      conversationState: state.postExecutionState,
      conversationContext: state.finalContextUpdate,
    });

    return { text: finalText, entityCacheUpdate: {} };
  }

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
    state.ragPayload = ragPayload;
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
      retrievalDomainMatch = hasDomainMatch(state.classification.metadata?.domain, ragPayload);
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
      const { loadYaml } = await import("../../utils/config");
      const pathModule = await import("path");
      const { fileURLToPath } = await import("url");
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = pathModule.dirname(__filename);
      const configPath = pathModule.join(__dirname, "../../config/approved-commands.yaml");
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

  let confirmationAbort: { prompt: string; context: ConversationContext; state: ConversationContext } | null = null;
  let clarificationAbort: { prompt: string; context: ConversationContext; state: ConversationContext } | null = null;

  // Session-scoped entity resolution cache: inject known entities so the LLM can resolve pronouns.
  // Built as a prepended system message (same pattern as ragMessage / vmContextMessage).
  const entityCacheUpdate: Record<string, string> = {};
  const entityCacheMessage: { role: "system"; content: string }[] =
    entityCache && Object.keys(entityCache).length > 0
      ? [
          {
            role: "system" as const,
            content:
              `Resolved entities from this session:\n` +
              Object.entries(entityCache)
                .map(([k, v]) => `  "${k}" → ${v}`)
                .join("\n") +
              `\nUse these to resolve pronouns and references.`,
          },
        ]
      : [];

  // P3.3: Plan-before-execute for multi-step ACTION intents.
  // When the classifier identifies an ACTION intent and actionIntent has keys (meaning
  // specific action-layer actions are involved), generate a structured plan first.
  // If the plan has 2+ steps, stream it to the UI and enter AWAITING_CONFIRMATION
  // before any tool executes. Single-step plans fall through to the normal loop.
  if (state.classification.intent === "ACTION" && actionIntent != null && Object.keys(actionIntent).length > 0) {
    const plan = await generateActionPlan({ userInput, sessionId });
    if (plan !== null && plan.steps.length > 1) {
      // Persist plan on state so callers (runner.ts) can inspect it later
      state.executionPlan = plan;

      // Emit plan event so the UI can render it before confirmation
      eventBus.emit({
        type: "agent:plan",
        sessionId,
        timestamp: Date.now(),
        data: {
          type: "agent:plan",
          plan,
          pendingConfirmationId: sessionId,
        },
      });

      // Return early — the runner will set conversationState to AWAITING_CONFIRMATION
      // using the existing confirmation flow. No tools have executed yet.
      return {
        text: `I've prepared a ${plan.steps.length}-step plan: ${plan.summary}\n\nPlease confirm to proceed.`,
        entityCacheUpdate: {},
      };
    }
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    logger.info(`Reasoning step ${step + 1}/${MAX_STEPS}`);

    emitStepEvent(eventBus, sessionId, {
      step: step + 1,
      maxSteps: MAX_STEPS,
      userInput: state.effectiveUserInput,
    });

    // Initialize reasoning step
    const reasoningStep: ReasoningStep = {
      step: step + 1,
      toolCalls: [],
      decisions: [],
    };

    // Attach retrieval decisions + artifact references and conversation path on step 1.
    if (step === 0) {
      // Observability: record how we reached EXECUTE (direct vs after clarify/confirm).
      const pathParts: string[] = ["EXECUTE"];
      if (state.clarificationContinuation.usedContinuation) pathParts.unshift("clarification_continuation");
      if (usedPendingAction) pathParts.unshift("user_confirmed");
      reasoningStep.decisions.push({
        type: "conversation_path",
        description: `Conversation path: ${pathParts.join(" → ")}. Router decision=EXECUTE. Trace reflects this run.`,
        metadata: {
          decision: "EXECUTE",
          planDecision: state.conversationPlan.decision,
          handler: "execute",
          conversationStateBefore: options.conversationState ?? "IDLE",
          usedClarificationContinuation: state.clarificationContinuation.usedContinuation,
          clarificationAnchor: state.clarificationContinuation.anchorUserInput ?? undefined,
          usedPendingAction,
          pendingActionId: pendingActionId ?? undefined,
          originalUserInput: state.originalUserInput,
          effectiveUserInput: userInput,
        },
      });
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

    const compositeInstructionMessage = isCompositeQuery
      ? [{ role: "system" as const, content: COMPOSITE_MULTI_STEP_INSTRUCTION }]
      : [];
    const messages = [
      { role: "system", content: buildSystemPrompt(state.responseMode) },
      ...compositeInstructionMessage,
    ...memoryContextMessage,
      ...entityCacheMessage,
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

          const targetToolForParse = tools.find((t) => t.metadata.name === toolName);
          const parseResult = parseToolArgs(
            fnCall.arguments,
            targetToolForParse?.getParameterSchema?.()
          );
          if (!parseResult.ok) {
            logger.warn("Tool argument parse/validate failed (parallel path)", { toolName, error: parseResult.error });
            reasoningStep.toolCalls.push({
              toolName,
              parameters: {},
              result: { success: false, error: parseResult.error },
              durationMs: 0,
            });
            totalToolCalls++;
            return null;
          }
          const parsedArgs = parseResult.args;

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
            data: { type: "tool:start", toolName, parameters: parsedArgs, toolCallId: toolCall.id },
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
              type: "tool:complete",
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

        const targetToolForParse = tools.find((t) => t.metadata.name === toolName);
        const parseResult = parseToolArgs(
          fnCall.arguments,
          targetToolForParse?.getParameterSchema?.()
        );
        if (!parseResult.ok) {
          logger.warn("Tool argument parse/validate failed", { toolName, error: parseResult.error });
          reasoningStep.toolCalls.push({
            toolName,
            parameters: {},
            result: { success: false, error: parseResult.error },
            durationMs: 0,
          });
          totalToolCalls++;
          context.addToolResult(toolCall.id, toolName, {
            provenanceId: `tool://${toolName}/parse-error-${Date.now()}`,
            success: false,
            error: parseResult.error,
          });
          continue;
        }
        const hydratedArgs = hydrateProxmoxReadArgs(
          toolName,
          parseResult.args,
          resolvedVmEntity
        );
        const parsedArgs = hydratedArgs.args;
        if (hydratedArgs.hydrated.length > 0) {
          reasoningStep.decisions.push({
            type: "parameter_hydration",
            description: `Reused resolved VM identity for ${toolName}`,
            metadata: {
              toolName,
              hydrated: hydratedArgs.hydrated,
              node: parsedArgs.node,
              vmid: parsedArgs.vmid,
            },
          });
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
          data: { type: "tool:start", toolName, parameters: parsedArgs, toolCallId: toolCall.id },
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
        const effectiveRisk = maxRisk(state.classification.risk, toolRisk, derivedRisk ?? "READ");
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
            state: "NEED_CLARIFICATION" as any,
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
            state: "AWAITING_CONFIRMATION" as any,
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
            type: "tool:complete",
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
        if (!result.error) {
          resolvedVmEntity =
            extractResolvedVmEntity(toolName, result.data) ?? resolvedVmEntity;
        }

        // Extract entity info for session-scoped resolution cache.
        // Only cache from tools that return infrastructure entities; skip large lists.
        if (
          !result.error &&
          result.data &&
          (toolName === "twin_query" || toolName === "proxmox_readonly" || toolName === "action")
        ) {
          const data = result.data as Record<string, unknown>;
          const isLargeList =
            Array.isArray(data) && (data as unknown[]).length > 5;
          if (!isLargeList) {
            const name = typeof data.name === "string" ? data.name : undefined;
            const vmid = data.vmid ?? data.vmId;
            const node = typeof data.node === "string" ? data.node : undefined;
            if (name && vmid !== undefined && vmid !== null) {
              entityCacheUpdate[name.toLowerCase()] = `vm:${vmid}`;
            } else if (name && node) {
              entityCacheUpdate[name.toLowerCase()] = node;
            }
          }
        }

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
            const reclassification = await reclassifyIntentWithContext(
              userInput,
              failureContext,
              originalClassification,
              classifyIntentWithLLM
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
          ...state.contextUpdate,
          ...clarificationAbort.context,
        };
        emitFinalEvent(eventBus, sessionId, startTime, clarificationAbort.prompt, {
          clarification: true,
          needsResponse: true,
          classification: state.classification,
          conversationState: clarificationAbort.state,
          conversationContext: mergedContext,
        });
        return { text: clarificationAbort.prompt, entityCacheUpdate };
      }

      if (confirmationAbort) {
        const mergedContext: ConversationContext = {
          ...state.contextUpdate,
          ...confirmationAbort.context,
        };
        emitFinalEvent(eventBus, sessionId, startTime, confirmationAbort.prompt, {
          confirmationRequired: true,
          confirmationId: mergedContext.pendingActionId,
          confirmationPreview: mergedContext.pendingActionPreview ?? mergedContext.pendingActionSummary,
          confirmationExpiresAt: mergedContext.pendingActionExpiresAt ?? 0,
          classification: state.classification,
          conversationState: confirmationAbort.state,
          conversationContext: mergedContext,
        });
        return { text: confirmationAbort.prompt, entityCacheUpdate };
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
        state.classification.intent === "ACTION" &&
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
        // Enrich response with bot-moves context for ASSISTIVE/EXPLAINER modes.
        // ResponseMode formatting instructions are in the system prompt (buildSystemPrompt),
        // so no second LLM call is needed here.
        try {
          if (state.responseMode === "ASSISTIVE" || state.responseMode === "EXPLAINER") {
            const movesContext = await buildBotMoveContext(finalText, state.classification.intent);
            if (movesContext) {
              finalText = `${movesContext}\n\n${finalText}`;
            }
          }
        } catch (error: any) {
          logger.warn("Failed to enrich response with moves context", { error: error.message });
          // Continue with unenriched response
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
          provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: state.responseMode }),
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

      // Structure the final response into reusable presentation primitives.
      let structuredResponse: AgentResponse | undefined;
      try {
        const toolCallSummary = reasoningSteps.flatMap((s) =>
          s.toolCalls.map((tc) => ({
            tool: tc.toolName,
            ok: !tc.result?.error,
            durationMs: tc.durationMs,
          }))
        );
        const convState = shouldPreserveConfirmationPrompt
          ? "AWAITING_CONFIRMATION"
          : shouldPreserveClarificationQuestion
            ? "NEED_CLARIFICATION"
            : "IDLE";
        const { object } = await generateObject({
          model: aiSdkOpenai("gpt-4o-mini") as unknown as Parameters<typeof generateObject>[0]["model"],
          schema: AgentResponseSchema,
          system: buildStructuredResponsePrompt(state.responseMode),
          prompt: [
            `User query: ${userInput}`,
            `Raw answer: ${finalText}`,
            `Tool calls made: ${JSON.stringify(toolCallSummary)}`,
            `Conversation state: ${convState}`,
          ].join("\n"),
        });
        structuredResponse = { ...object, rawTextFallback: finalText };
      } catch (err: any) {
        logger.warn("Agent response structuring failed; using the text response", { err: err?.message });
      }

      // Emit agent:final event with trace ID
      const durationMs = Date.now() - startTime;
      emitFinalEvent(eventBus, sessionId, startTime, finalText, {
        totalSteps: step + 1,
        totalToolCalls,
        traceId,
        structuredResponse,
        conversationState: shouldPreserveClarificationQuestion
          ? "NEED_CLARIFICATION"
          : shouldPreserveConfirmationPrompt
            ? "AWAITING_CONFIRMATION"
            : state.postExecutionState,
        conversationContext: state.finalContextUpdate,
        clarification: shouldPreserveClarificationQuestion,
        needsResponse: shouldPreserveClarificationQuestion || shouldPreserveConfirmationPrompt,
      });

      return { text: finalText, entityCacheUpdate };
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
      provenance: buildProvenance({ toolRegistryVersion, policyMode, selectedMode: state.responseMode }),
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

  emitFinalEvent(eventBus, sessionId, startTime, "Max reasoning depth reached. Please try a simpler query.", {
    totalSteps: reasoningSteps.length,
    totalToolCalls,
    traceId,
    conversationState: state.conversationPlan.nextState,
    conversationContext: state.contextUpdate,
  });

  return { text: "Max reasoning depth reached. Please try a simpler query.", entityCacheUpdate };
}
