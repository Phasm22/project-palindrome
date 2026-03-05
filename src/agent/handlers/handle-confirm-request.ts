/**
 * Handles ASK_CONFIRM: build pending action record, format confirmation prompt, emit and return.
 */

import { createHash } from "node:crypto";
import type { AgentEventBus } from "../event-bus";
import type { AgentStateV1 } from "../state";
import { emitFinalEvent } from "./emit-helpers";
import { logger } from "../../utils/logger";
import { pceLogger } from "../../pce/utils/logger";

export interface PendingActionRecord {
  id: string;
  digest: string;
  createdAt: number;
  expiresAt: number;
  type: string;
  preview: string;
  executeInput: string;
  summary: string;
}

function buildPendingActionRecord(
  executeInput: string,
  summary?: string,
  type: string = "change_request"
): PendingActionRecord {
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
}

export interface HandleConfirmRequestInput {
  state: AgentStateV1;
  conversationStateBefore?: string;
  eventBus: AgentEventBus;
}

export interface HandleConfirmRequestResult {
  text: string;
}

/**
 * Emit confirmation request and return the prompt text. Call when conversationPlan.decision === "ASK_CONFIRM".
 */
export function handleConfirmRequest(input: HandleConfirmRequestInput): HandleConfirmRequestResult {
  const {
    state,
    conversationStateBefore,
    eventBus,
  } = input;
  const {
    effectiveUserInput,
    classification,
    contextUpdate,
    conversationPlan,
    sessionId,
    startTime,
  } = state;
  const intentType = `intent:${classification.intent.toLowerCase()}`;

  const pendingRecord = buildPendingActionRecord(
    effectiveUserInput,
    conversationPlan.pendingAction ?? effectiveUserInput,
    intentType
  );
  const confirmationPrompt =
    `Review pending change: ${pendingRecord.preview}\n` +
    `Reply with CONFIRM ${pendingRecord.id} to apply, or CANCEL.`;

  pceLogger.incrementCounter("confirmation_requested");
  logger.info("Conversation transition", {
    conversation_state_before: conversationStateBefore ?? "IDLE",
    decision: "ASK_CONFIRM",
    confirmation_id: pendingRecord.id,
    pending_action_source: "plan_conversation",
  });

  emitFinalEvent(eventBus, sessionId, startTime, confirmationPrompt, {
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
