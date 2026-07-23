import type { AgentEventBus } from "../event-bus";
import type { AgentFinalPayload, AgentStepPayload } from "../event-payloads";
import { createTextAgentResponse } from "../schemas/agent-response";

export type AgentStepEventData = {
  step: number;
  maxSteps: number;
  userInput?: string;
  intent?: string;
  tool?: string;
  mode?: string;
} & Record<string, unknown>;

export function emitStepEvent(
  eventBus: AgentEventBus,
  sessionId: string,
  data: AgentStepEventData
): void {
  const payload: AgentStepPayload = { type: "agent:step", ...data };
  eventBus.emit({
    type: "agent:step",
    sessionId,
    timestamp: Date.now(),
    data: payload,
  });
}

export function emitFinalEvent(
  eventBus: AgentEventBus,
  sessionId: string,
  startTime: number,
  text: string,
  extra: (Partial<Omit<AgentFinalPayload, "type" | "text" | "durationMs">> & Record<string, unknown>) = {}
): void {
  const totalSteps = typeof extra.totalSteps === "number" ? extra.totalSteps : 0;
  const totalToolCalls = typeof extra.totalToolCalls === "number" ? extra.totalToolCalls : 0;
  const conversationState = typeof extra.conversationState === "string"
    ? extra.conversationState
    : "IDLE";
  const state = [
    "IDLE",
    "NEED_CLARIFICATION",
    "AWAITING_CONFIRMATION",
    "READY_READ",
    "READY_WRITE",
  ].includes(conversationState)
    ? conversationState as "IDLE" | "NEED_CLARIFICATION" | "AWAITING_CONFIRMATION" | "READY_READ" | "READY_WRITE"
    : "IDLE";
  const providedStructuredResponse = extra.structuredResponse as AgentFinalPayload["structuredResponse"] | undefined;
  const structuredResponse = providedStructuredResponse ?? createTextAgentResponse(text, {
    state,
    pendingActionId: typeof extra.pendingActionId === "string" ? extra.pendingActionId : undefined,
    traceId: typeof extra.traceId === "string" ? extra.traceId : undefined,
  });
  const payload: AgentFinalPayload = {
    type: "agent:final",
    ...extra,
    structuredResponse,
    text,
    totalSteps,
    totalToolCalls,
    durationMs: Date.now() - startTime,
  };
  eventBus.emit({
    type: "agent:final",
    sessionId,
    timestamp: Date.now(),
    data: payload,
  });
}
