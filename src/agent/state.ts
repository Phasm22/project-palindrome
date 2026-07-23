import type { BaseTool } from "../tools/BaseTool";
import type { IntentClassification } from "../reasoning/intent-classifier";
import type { RoutingDecision } from "../reasoning/intent-router";
import type { OrchestratorDecision } from "./conversation-orchestrator";
import type { ConfirmationParseResult } from "./dialog-policy";
import type { ClarificationContinuationResult } from "./clarification-continuation";
import type { ToolSession } from "./tool-policy";
import type { ConversationContext, ConversationState } from "../types";
import type { ResponseMode } from "./response-formatter";
import type { HybridApiContext } from "./rag-client";

export interface AgentStateV1 {
  originalUserInput: string;
  effectiveUserInput: string;
  sessionId: string;
  startTime: number;
  session: ToolSession;
  options: AgentRunOptions;
  classification: IntentClassification;
  routing: RoutingDecision;
  conversationPlan: OrchestratorDecision;
  confirmation: ConfirmationParseResult;
  clarificationContinuation: ClarificationContinuationResult;
  tools: BaseTool[];
  contextUpdate: Partial<ConversationContext>;
  finalContextUpdate: Partial<ConversationContext>;
  postExecutionState: ConversationState;
  responseMode: ResponseMode | undefined;
  ragPayload: HybridApiContext | null;
  executionPlan?: import("./schemas/action-step").ActionPlan;
}

export interface BuildAgentStateInput {
  originalUserInput: string;
  effectiveUserInput: string;
  sessionId: string;
  startTime: number;
  session: ToolSession;
  options: AgentRunOptions;
  classification: IntentClassification;
  routing: RoutingDecision;
  conversationPlan: OrchestratorDecision;
  confirmation: ConfirmationParseResult;
  clarificationContinuation: ClarificationContinuationResult;
  tools: BaseTool[];
  contextUpdate: Partial<ConversationContext>;
  finalContextUpdate: Partial<ConversationContext>;
  postExecutionState: ConversationState;
  responseMode: ResponseMode | undefined;
  ragPayload?: HybridApiContext | null;
}

export function buildAgentState(input: BuildAgentStateInput): AgentStateV1 {
  return {
    ...input,
    ragPayload: input.ragPayload ?? null,
  };
}

// Local re-export of AgentRunOptions to avoid circular imports.
// The canonical type lives in runner.ts; this alias keeps handler files decoupled
// from the full runner implementation.
export type AgentRunOptions = import("./runner").AgentRunOptions;
