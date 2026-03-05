import type { AgentEventBus } from "../event-bus";
import type { AgentFinalPayload, AgentStepPayload } from "../event-payloads";

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
  const payload: AgentFinalPayload = {
    type: "agent:final",
    ...extra,
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

