import { randomUUID } from "node:crypto";
import type { AgentEventBus } from "./event-bus";
import type { OperatorMemoryStore } from "../pce/api/operator-memory-store";
import type { AgentFinalPayload } from "./event-payloads";
import type { AgentEvent } from "./event-bus";

export function registerFeedbackObserver(
  bus: AgentEventBus,
  store: OperatorMemoryStore,
  userId: string,
  aclGroup: string,
  intentType: string,
  actionName?: string,
): void {
  bus.onType("agent:final", (event: AgentEvent) => {
    const payload = event.data as AgentFinalPayload;
    if (event.sessionId == null) return;

    const toolCalls = payload.toolCalls ?? [];
    const allOk = toolCalls.length === 0 || toolCalls.every((tc) => tc.ok);
    const hasErrorState = payload.conversationState === "ERROR";
    const success = allOk && !hasErrorState;

    const failedTool = toolCalls.find((tc) => !tc.ok);
    const errorCategory = failedTool?.tool ?? undefined;

    const confirmationRequired = payload.confirmationRequired === true;
    const confirmationGiven = confirmationRequired && payload.pendingActionId == null;

    store.recordOutcome({
      id: randomUUID(),
      sessionId: event.sessionId,
      userId,
      aclGroup,
      intentType,
      actionName,
      success,
      errorCategory,
      durationMs: payload.durationMs,
      fallbackUsed: false,
      confirmationRequired,
      confirmationGiven,
      timestamp: event.timestamp,
    });
  });
}
