/**
 * Retrieval (RAG) eligibility for the EXECUTE path. Used by the runner to decide
 * whether to run hybrid RAG before the first LLM call. Composite queries bypass
 * tool_first_domain so they get RAG context and can plan multiple tool steps.
 */

export const TOOL_FIRST_DOMAINS = ["compute", "network", "firewall", "metrics"] as const;

export interface GetRetrievalEligibilityParams {
  intent: string;
  domain?: string;
  isTrivialQuery: boolean;
  isActionIntent: boolean;
  isRealTimeMetricQuery: boolean;
  isMetaIdentityQuery: boolean;
  isCompositeQuery?: boolean;
}

export function getRetrievalEligibility(params: GetRetrievalEligibilityParams): {
  eligible: boolean;
  reason?: string;
} {
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
  // Tool-first: for infra domains we have tools; skip RAG so the model uses live data.
  // For composite queries, allow RAG so the agent has context to plan multiple tool steps.
  if (
    params.intent === "QUERY" &&
    params.domain &&
    (TOOL_FIRST_DOMAINS as readonly string[]).includes(params.domain) &&
    !params.isCompositeQuery
  ) {
    return { eligible: false, reason: "tool_first_domain" };
  }
  if (params.intent !== "QUERY" && params.intent !== "CHAT_REASONING") {
    return { eligible: false, reason: "intent_not_retrieval" };
  }
  return { eligible: true };
}
