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
import { AgentResponseSchema, createTextAgentResponse, type AgentResponse } from "../schemas/agent-response";
import { ConnectionTargetSchema, type ConnectionEndpoint } from "../../types/connections";
import {
  buildConnectionEndpoints,
  resolveConnectionTarget,
  verifyConnectionEndpoints,
} from "../../connections/verifier";
import { fetchHybridContext, type HybridApiContext } from "../rag-client";
import {
  getToolRisk,
  isToolAuthorized,
  requiresConfirmation,
  runWithToolAcl,
  type ToolSession,
} from "../tool-policy";
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
import { applyAdaptivePackaging, prettifyRawPfctlText } from "../response-formatter";
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
import {
  extractResolvedVmEntity,
  hydrateProxmoxReadArgs,
  type ResolvedVmEntity,
} from "./tool-argument-hydration";
import {
  detectVmProvenanceIntent,
  formatVmProvenanceAnswer,
} from "../vm-provenance";

/**
 * MAX_STEPS policy (2026-07-21 fuzz campaign, Task 2). Evidence from 10 live MAXSTEPS hits
 * across fuzz-results-2026-07-21.jsonl and fuzz-reverify-results-2026-07-21.jsonl split into
 * three distinct patterns, only one of which a bigger flat budget actually helps:
 *
 *  1. Genuine forward progress that ran out of budget (e.g. "Run a full health diagnostic on
 *     windowsVM" — 12 real tool calls across 5 steps, still climbing toward a real answer when
 *     the budget ran out; "For every stopped VM, tell me which node it's on..." — real
 *     per-node data gathered, cut short before covering all nodes). These are genuinely
 *     multi-step query *shapes* (composite questions, "all nodes" sweeps, "for every X"
 *     iteration, explicit "full/complete diagnostic" requests) that routinely need more than
 *     5 LLM turns. BASE_MAX_STEPS stays 5 for the common case (most queries resolve in 1-3
 *     turns; raising the ceiling for everyone would only make already-failing queries slower
 *     and more expensive, not help successes) — computeMaxSteps() extends the budget only for
 *     these specific shapes.
 *  2. Thrashing: the same tool call fails identically on every retry (e.g. "Traceroute to
 *     8.8.8.8" repeated the exact same failing command 3x with only cosmetic param changes).
 *     More budget would just make the eventual (identical) failure slower and costlier.
 *  3. A genuine loop bug, not a budget problem: when the LLM returns neither a tool call nor
 *     final text, nothing gets appended to the conversation context, so the *next* iteration
 *     re-sends an unchanged prompt — observed as 2-4 consecutive "no tool calls this step"
 *     entries in traces (e.g. "Which nodes have VMs on both the home and lab subnets...",
 *     "For every stopped VM..."). This silently burns the entire remaining budget for zero
 *     benefit regardless of how big MAX_STEPS is. isStuckOnEmptyStep() + the empty-step nudge
 *     in the main loop fix this directly instead of just giving it more budget to waste.
 *
 * Full evidence and per-query classification: see the "MAX_STEPS policy" section appended to
 * docs/tests/fuzz-campaign-2026-07-21.md.
 */
export const BASE_MAX_STEPS = 5;
export const EXTENDED_MAX_STEPS = 8;

/** A step is "stuck" (making zero forward progress) after this many consecutive empty steps. */
export const EMPTY_STEP_STUCK_THRESHOLD = 2;

/**
 * Decides the step budget for one agent run. Extends the base budget only for query shapes
 * that the campaign evidence showed genuinely need more than 5 LLM turns — composite
 * (multi-dimension) questions, "all nodes" sweeps, explicit full/complete diagnostic requests,
 * and "for every/each X" iteration-over-entities questions. Everything else keeps the tight
 * default so failures (thrashing, capability gaps) stay cheap and fast.
 */
export function computeMaxSteps(params: {
  isCompositeQuery: boolean;
  isAllNodesQuery: boolean;
  userInput: string;
}): number {
  const { isCompositeQuery, isAllNodesQuery, userInput } = params;
  const isFullDiagnosticRequest = /\b(full|complete|comprehensive)\s+(health\s+)?diagnostic\b/i.test(userInput);
  const isIterateAllEntitiesQuery = /\bfor\s+(every|each)\b/i.test(userInput);
  const needsExtendedBudget =
    isCompositeQuery || isAllNodesQuery || isFullDiagnosticRequest || isIterateAllEntitiesQuery;
  return needsExtendedBudget ? EXTENDED_MAX_STEPS : BASE_MAX_STEPS;
}

/**
 * True once the loop has produced this many consecutive steps with neither a tool call nor
 * final text — i.e. genuinely zero forward progress, not just a slow multi-step query. Distinct
 * from MAX_STEPS: this fires regardless of how much budget remains, because more of the same
 * unchanged prompt won't help (see the MAX_STEPS policy comment above).
 */
export function isStuckOnEmptyStep(
  consecutiveEmptySteps: number,
  threshold: number = EMPTY_STEP_STUCK_THRESHOLD
): boolean {
  return consecutiveEmptySteps >= threshold;
}

/**
 * True when a step emitted tool calls but every one was filtered out as an exact
 * duplicate of a call already tried this run (via the seenToolCalls dedup) — so the step
 * burned an LLM turn for zero new information. Distinct from an empty step (which carries
 * no tool_calls at all): isStuckOnEmptyStep()'s counter never sees this case because the
 * raw LLM response *did* carry tool_calls, so consecutiveEmptySteps was reset. Evidenced
 * live in RV-CRASH-05 and F-08 (2026-07-21 fuzz-campaign residuals — steps that are 100%
 * duplicate_detected, zero real tool calls). Folded into the same stuck-detection budget
 * as empty steps because more of the same re-proposed calls can't help either.
 */
export function isDuplicateOnlyStep(params: {
  toolCallCount: number;
  duplicateCount: number;
  executedCount: number;
}): boolean {
  const { toolCallCount, duplicateCount, executedCount } = params;
  return toolCallCount > 0 && executedCount === 0 && duplicateCount > 0;
}

/**
 * At the MAX_STEPS boundary, decide whether to attempt a final tool-free synthesis from
 * the results already gathered instead of discarding everything behind the canned "max
 * reasoning depth" message. Gated on "at least one tool call this run succeeded": with no
 * successful data there is nothing to synthesize from, so the canned message stays the
 * honest answer. See RV-CRASH-03/RV-CRASH-05 (2026-07-21 fuzz-campaign residual), which
 * reached the budget holding genuinely-answerable data then threw it away.
 */
export function shouldSynthesizeAtBoundary(succeededToolCallCount: number): boolean {
  return succeededToolCallCount > 0;
}

/** User-facing message when the step budget is exhausted with nothing to synthesize. */
export const MAX_STEPS_CANNED_MESSAGE = "Max reasoning depth reached. Please try a simpler query.";

/** Instruction for the boundary-synthesis LLM call (no tools are offered on this call). */
export const MAX_STEPS_SYNTHESIS_INSTRUCTION =
  "You have reached the maximum number of reasoning steps and can no longer call any tools. " +
  "Using ONLY the tool results already gathered earlier in this conversation, give the best answer " +
  "you can to the user's question. Summarize what the tool results actually show. If they only " +
  "partially answer the question, provide the partial answer and briefly note what could not be " +
  "determined. Do not invent data that is not present in the tool results.";

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
  return runWithToolAcl(input.session.aclGroup, () => handleExecuteWithAcl(input));
}

async function handleExecuteWithAcl(
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

  const throwIfStopped = () => options.signal?.throwIfAborted();
  throwIfStopped();
  // Generated upfront (not inside recordTrace) so every tool_executions row
  // written during this run can be stamped with the trace it belongs to,
  // enabling a reliable join instead of fuzzy timestamp/toolName matching.
  // Named distinctly from the several local `traceId` variables below
  // (each holds recordTrace()'s return value for its own code path) to
  // avoid confusing shadowing — this is the one value both sides agree on.
  const runTraceId = crypto.randomUUID();
  let connectionEndpoints: ConnectionEndpoint[] = [];

  const emitConnectionUpdate = (
    phase: "candidates" | "verifying" | "complete",
    endpoints: ConnectionEndpoint[],
    resource?: string
  ) => {
    eventBus.emit({
      type: "connection:update",
      sessionId,
      timestamp: Date.now(),
      data: { type: "connection:update", phase, resource, endpoints },
    });
  };

  const attachVerifiedConnections = async (result: ExecutionResult): Promise<void> => {
    if (!result.data || typeof result.data !== "object") return;
    const parsed = ConnectionTargetSchema.safeParse((result.data as any).connectionTarget);
    if (!parsed.success) return;

    const target = await resolveConnectionTarget(parsed.data);
    throwIfStopped();
    const candidates = buildConnectionEndpoints(target);
    if (candidates.length === 0) return;
    emitConnectionUpdate("candidates", candidates, target.hostname);
    eventBus.emitProgress({
      toolName: "connection_verifier",
      action: "verify_connections",
      status: "verifying",
      message: `Verifying ${candidates.length} connection endpoint(s) for ${target.hostname}...`,
      progress: 0.85,
      details: { hostname: target.hostname, endpoints: candidates.length },
    }, sessionId);

    const verified = await verifyConnectionEndpoints(candidates, target.ipAddresses, {
      signal: options.signal,
      sshDeadlineMs: Number(process.env.CONNECTION_SSH_DEADLINE_MS || 300_000),
      httpDeadlineMs: Number(process.env.CONNECTION_HTTP_DEADLINE_MS || 120_000),
      retryIntervalMs: Number(process.env.CONNECTION_RETRY_INTERVAL_MS || 5_000),
      onUpdate: (endpoints) => emitConnectionUpdate(
        endpoints.every((endpoint) => endpoint.status !== "pending") ? "complete" : "verifying",
        endpoints,
        target.hostname
      ),
    });
    connectionEndpoints = [
      ...connectionEndpoints.filter((existing) => !verified.some((endpoint) => endpoint.id === existing.id)),
      ...verified,
    ];
    (result.data as any).connections = verified;
    const failed = verified.some((endpoint) => endpoint.status === "failed");
    eventBus.emitProgress({
      toolName: "connection_verifier",
      action: "verify_connections",
      status: failed ? "failed" : "completed",
      message: `${verified.filter((endpoint) => endpoint.status === "verified").length}/${verified.length} connection endpoint(s) verified for ${target.hostname}.`,
      progress: 1,
      details: { hostname: target.hostname },
    }, sessionId);
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
        { userId: session.userId, aclGroup: session.aclGroup, traceId: runTraceId }
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
        { userId: session.userId, aclGroup: session.aclGroup, traceId: runTraceId }
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
      { userId: session.userId, aclGroup: session.aclGroup, traceId: runTraceId }
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
            traceId: runTraceId,
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
            traceId: runTraceId,
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
        id: runTraceId,
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
      { userId: session.userId, aclGroup: session.aclGroup, traceId: runTraceId }
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
        { userId: session.userId, aclGroup: session.aclGroup, traceId: runTraceId }
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
        id: runTraceId,
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

  // Track "all nodes" queries to prevent partial answers
  // Match patterns like "all nodes", "all the nodes", "temperature of all nodes", etc.
  const isAllNodesQuery = /\ball\s+(the\s+)?nodes?\b/i.test(userInput);

  const MAX_STEPS = computeMaxSteps({ isCompositeQuery, isAllNodesQuery, userInput });
  const MAX_TOOL_CALLS_PER_STEP = 5; // Prevent tool call flooding (reduced from 10)
  const seenToolCalls = new Set<string>(); // Track tool calls to prevent infinite loops
  const client = getOpenAIClient();

  // Track if we've successfully retrieved data for real-time metric queries
  // Once we have the data, allow text responses instead of forcing more tool calls
  let hasRealTimeMetricData = false;

  // Track consecutive steps where the LLM produced neither a tool call nor final text.
  // See isStuckOnEmptyStep() for why this needs its own guard, separate from MAX_STEPS.
  let consecutiveEmptySteps = 0;
  // Count tool calls that actually executed and succeeded this run — gates boundary
  // synthesis (Residual 2): only synthesize a final answer if there is real data to use.
  let succeededToolCallCount = 0;
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

  for (let step = 0; step < MAX_STEPS; step++) {
    throwIfStopped();
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
      model: process.env.AGENT_CHAT_MODEL || "gpt-4o",
      messages,
    };

    if (openaiTools.length > 0) {
      request.tools = openaiTools;
      // For real-time metric queries, force tool usage ONLY if we haven't gotten the data yet
      // Once we have the data (hasRealTimeMetricData), allow text responses
      request.tool_choice = (isRealTimeMetricQuery && !hasRealTimeMetricData) ? "required" : "auto";
    }

    const response = await client.chat.completions.create(request, { signal: options.signal });
    throwIfStopped();
    const message = response.choices[0]?.message;

    // Capture LLM response
    reasoningStep.llmResponse = message?.content || "";

    const toolCalls = ((message?.tool_calls as any[]) ?? []) as Array<any>;
    if (toolCalls.length) {
      // Per-step productivity counters (Residual 1: duplicate-only-step stall). A step
      // that executes at least one tool call made forward progress; a step whose calls
      // were ALL filtered as duplicates made none. Assessed after the batch, below.
      let executedToolCallsThisStep = 0;
      let duplicateToolCallsThisStep = 0;
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
          throwIfStopped();
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
          if (!targetTool || !isToolAuthorized(targetTool, session, parsedArgs)) {
            return null;
          }

          const provenanceId = `tool://${toolName}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const node = parsedArgs.node || parsedArgs.host;
          const execContext = {
            userId: session.userId,
            aclGroup: session.aclGroup,
            node,
            sessionId,
            traceId: runTraceId,
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
          await attachVerifiedConnections(result);
          throwIfStopped();

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
          executedToolCallsThisStep++;
          if (!result.error) succeededToolCallCount++;

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
        // Failure-reclassification context messages must NOT be inserted into the
        // conversation until every tool_call_id in this batch has a tool-role
        // response — OpenAI's API requires all tool responses for an assistant
        // message to directly follow it with no other role in between. Adding a
        // user message mid-loop (before later tool calls in the same batch are
        // processed) previously produced: "An assistant message with 'tool_calls'
        // must be followed by tool messages responding to each 'tool_call_id'" on
        // the next LLM call — see fuzz-campaign-2026-07-21.md CRASH findings.
        const pendingFailureContextMessages: string[] = [];
        for (const toolCall of toolCalls) {
        throwIfStopped();
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
          duplicateToolCallsThisStep++;
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
            duplicateToolCallsThisStep++;
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

        if (!isToolAuthorized(targetTool, session, parsedArgs)) {
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
          sessionId,
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
              { userId: session.userId, aclGroup: session.aclGroup, traceId: runTraceId }
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
          throwIfStopped();

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
            await attachVerifiedConnections(result);
            throwIfStopped();
          }
        } else {
          result = await executeToolCall(
            { toolName, parameters: parsedArgs },
            tools,
            execContext
          );
          await attachVerifiedConnections(result);
          throwIfStopped();
        }
        executedToolCallsThisStep++;

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
          succeededToolCallCount++;
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

            // If reclassification suggests a different approach, add context to help LLM.
            // Deferred until after the full toolCalls batch is processed (see comment
            // above the loop) so we never insert a user message between two tool
            // responses that both belong to the same assistant tool_calls message.
            if (reclassification.shouldRetry && reclassification.suggestedAction) {
              pendingFailureContextMessages.push(
                `Previous attempt failed: ${result.error}. ${reclassification.suggestedAction}`
              );
            } else if (!reclassification.shouldRetry) {
              // Don't retry - add context explaining why
              pendingFailureContextMessages.push(
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

        // Now that every tool_call_id in this batch has a tool-role response,
        // it's safe to add any deferred failure-context messages.
        for (const message of pendingFailureContextMessages) {
          context.addUserMessage(message);
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

      // Productivity assessment (Residual 1). A step whose tool calls were ALL filtered as
      // duplicates made zero forward progress — the same stall the empty-step guard handles,
      // except the raw LLM response carried tool_calls so consecutiveEmptySteps never saw it.
      // Fold it into the same counter/threshold: nudge once so the next attempt has a
      // genuinely different prompt, then stop if it recurs, instead of burning the rest of
      // the budget re-proposing the identical calls (see RV-CRASH-05/F-08 in the report).
      let stuckBreakThisStep = false;
      if (executedToolCallsThisStep > 0) {
        consecutiveEmptySteps = 0;
      } else if (
        isDuplicateOnlyStep({
          toolCallCount: toolCalls.length,
          duplicateCount: duplicateToolCallsThisStep,
          executedCount: executedToolCallsThisStep,
        })
      ) {
        consecutiveEmptySteps++;
        reasoningStep.decisions.push({
          type: "empty_step",
          description: `All ${duplicateToolCallsThisStep} tool call(s) this step were filtered as duplicates — zero new information (${consecutiveEmptySteps} consecutive unproductive)`,
          metadata: { consecutiveEmptySteps, duplicateToolCalls: duplicateToolCallsThisStep },
        });
        if (isStuckOnEmptyStep(consecutiveEmptySteps)) {
          logger.warn(
            `Stuck: ${consecutiveEmptySteps} consecutive unproductive (duplicate-only) steps, stopping early`,
            { userInput: userInput.slice(0, 80), step: step + 1 }
          );
          stuckBreakThisStep = true;
        } else {
          context.addUserMessage(
            "Every tool call you just made repeats a call already tried this session, so it returned no new information. Either answer the question now using the results you already have, or call a different tool (or the same tool with different parameters). Do not repeat an identical call."
          );
        }
      }

      // Record this reasoning step
      reasoningSteps.push(reasoningStep);
      if (stuckBreakThisStep) break;
      continue;
    }

    // Record step even if no tool calls
    if (message?.content) {
      reasoningStep.llmResponse = message.content;
    }
    reasoningSteps.push(reasoningStep);

    let finalText = coerceTextContent(message?.content).trim();
    if (finalText) {
      // The EXECUTE-path LLM loop mixes tool output from multiple domains
      // (e.g. opnsense_readonly's live pfctl dump alongside twin_query
      // exposure data) with no second formatting pass. If the model echoed
      // raw pf rule syntax verbatim instead of summarizing it, clean that up
      // here before it reaches the user — see fuzz-campaign F-06.
      finalText = prettifyRawPfctlText(finalText);
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
          id: runTraceId,
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

      if (connectionEndpoints.length > 0) {
        structuredResponse ??= createTextAgentResponse(finalText, {
          state: shouldPreserveConfirmationPrompt
            ? "AWAITING_CONFIRMATION"
            : shouldPreserveClarificationQuestion
              ? "NEED_CLARIFICATION"
              : "IDLE",
        });
        structuredResponse.answer.sections.push({
          type: "connections",
          title: "Connections",
          data: connectionEndpoints,
        });
      }

      // Emit agent:final event with trace ID
      const durationMs = Date.now() - startTime;
      emitFinalEvent(eventBus, sessionId, startTime, finalText, {
        totalSteps: step + 1,
        totalToolCalls,
        traceId,
        structuredResponse,
        connections: connectionEndpoints,
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

    // Neither a tool call nor usable text: zero forward progress this step. Nothing was added
    // to context above, so looping again unchanged would very likely just repeat the same
    // non-answer (see the MAX_STEPS policy comment at the top of this file — this is the
    // "silent stall" pattern the 2026-07-21 campaign found eating the entire step budget for
    // no benefit). Nudge once so the next attempt has a genuinely different prompt; if that
    // doesn't help either, stop now instead of burning the rest of the budget on repeats.
    consecutiveEmptySteps++;
    // reasoningStep was already pushed to reasoningSteps above ("Record step even if no tool
    // calls"); mutate it in place rather than pushing a second time.
    reasoningStep.decisions.push({
      type: "empty_step",
      description: `Step produced neither a tool call nor a final answer (${consecutiveEmptySteps} consecutive)`,
      metadata: { consecutiveEmptySteps },
    });
    if (isStuckOnEmptyStep(consecutiveEmptySteps)) {
      logger.warn(`Stuck: ${consecutiveEmptySteps} consecutive empty steps, stopping early`, {
        userInput: userInput.slice(0, 80),
        step: step + 1,
      });
      break;
    }
    context.addUserMessage(
      "You did not call a tool or provide an answer. If you have enough information, answer the question now. Otherwise, call an appropriate tool."
    );
  }

  // Max steps reached (or stopped early — see isStuckOnEmptyStep above).
  const durationMs = Date.now() - startTime;

  // Residual 2 (boundary-synthesis discard): rather than always discarding every tool
  // result gathered this run behind the canned "max reasoning depth" message, make one
  // final tool-free LLM call to synthesize an answer from the results already in context —
  // but only when at least one tool call actually succeeded this run (otherwise there's
  // nothing to synthesize and the canned message is the honest answer). Evidenced by
  // RV-CRASH-03/RV-CRASH-05 (2026-07-21 fuzz campaign), which reached the budget holding
  // genuinely-answerable data (real uptime/df -h; real twin_query results) then threw it
  // all away. Any failure here degrades cleanly back to the canned message.
  let boundaryText = MAX_STEPS_CANNED_MESSAGE;
  let boundarySynthesized = false;
  if (shouldSynthesizeAtBoundary(succeededToolCallCount)) {
    try {
      const synthesisMessages = [
        { role: "system", content: buildSystemPrompt(state.responseMode) },
        ...ragMessage,
        ...context.getMessages(),
        { role: "system", content: MAX_STEPS_SYNTHESIS_INSTRUCTION },
      ] as any[];
      const synthResponse = await client.chat.completions.create(
        { model: process.env.AGENT_CHAT_MODEL || "gpt-4o", messages: synthesisMessages },
        { signal: options.signal }
      );
      throwIfStopped();
      const synthText = coerceTextContent(synthResponse.choices[0]?.message?.content).trim();
      if (synthText) {
        boundaryText = prettifyRawPfctlText(synthText);
        boundarySynthesized = true;
        context.addAssistantMessage(boundaryText);
        logger.info("Boundary synthesis produced an answer from gathered tool results", {
          succeededToolCallCount,
          totalSteps: reasoningSteps.length,
          query: userInput.slice(0, 80),
        });
      }
    } catch (error: any) {
      logger.warn("Boundary synthesis failed; falling back to canned max-steps message", {
        error: error?.message,
      });
    }
  }
  const lastReasoningStep = reasoningSteps[reasoningSteps.length - 1];
  if (lastReasoningStep) {
    lastReasoningStep.decisions.push({
      type: boundarySynthesized ? "boundary_synthesis" : "limit_reached",
      description: boundarySynthesized
        ? `Synthesized a final answer from ${succeededToolCallCount} successful tool call(s) at the step-budget boundary`
        : "Reached the step budget with no successful tool data to synthesize from",
      metadata: { succeededToolCallCount, totalSteps: reasoningSteps.length },
    });
  }

  let traceId: string | undefined;
  try {
    const traceStore = getReasoningTraceStore();
    traceId = await traceStore.recordTrace({
      id: runTraceId,
      userId: session.userId,
      aclGroup: session.aclGroup,
      userInput,
      finalResponse: boundaryText,
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

  emitFinalEvent(eventBus, sessionId, startTime, boundaryText, {
    totalSteps: reasoningSteps.length,
    totalToolCalls,
    traceId,
    conversationState: state.conversationPlan.nextState,
    conversationContext: state.contextUpdate,
  });

  return { text: boundaryText, entityCacheUpdate };
}
