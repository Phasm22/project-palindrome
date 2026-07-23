/**
 * Handles confirmation parsing and the 5 confirmation early-return paths.
 * Runs before classification; returns either a final response or effectiveInput + usedPendingAction.
 */

import type { ConfirmationParseResult } from "../dialog-policy";
import type { ConversationContext } from "../../types";
import type { AgentEventBus } from "../event-bus";
import { emitFinalEvent } from "./emit-helpers";
import { pceLogger } from "../../pce/utils/logger";

export interface HandleConfirmationInput {
  confirmation: ConfirmationParseResult;
  userInput: string;
  pendingActionId: string | undefined;
  pendingActionExecuteInput: string | undefined;
  pendingAction: string | undefined;
  pendingActionPreview: string | undefined;
  pendingActionSummary: string | undefined;
  pendingActionCreatedAt: number | undefined;
  pendingActionExpiresAt: number | undefined;
  pendingActionExpired: boolean;
  conversationContext: ConversationContext | undefined;
  eventBus: AgentEventBus;
  sessionId: string;
  startTime: number;
}

const EMPTY_PENDING_CONTEXT: Record<string, unknown> = {
  pendingAction: "",
  pendingActionId: "",
  pendingActionDigest: "",
  pendingActionCreatedAt: 0,
  pendingActionSummary: "",
  pendingActionType: "",
  pendingActionPreview: "",
  pendingActionExecuteInput: "",
  pendingActionExpiresAt: 0,
};

export type HandleConfirmationResult =
  | { handled: true; response: { text: string } }
  | { handled: false; effectiveInput: string; usedPendingAction: boolean };

export function handleConfirmation(input: HandleConfirmationInput): HandleConfirmationResult {
  const {
    confirmation,
    pendingActionId,
    pendingActionExecuteInput,
    pendingAction,
    pendingActionPreview,
    pendingActionSummary,
    pendingActionCreatedAt,
    pendingActionExpiresAt,
    pendingActionExpired,
    conversationContext,
    eventBus,
    sessionId,
    startTime,
  } = input;

  if (confirmation.cancelled) {
    const prompt = pendingActionId
      ? "Cancelled the pending change. Nothing was applied."
      : "There is no pending change to cancel.";
    emitFinalEvent(eventBus, sessionId, startTime, prompt, {
      clarification: true,
      needsResponse: true,
      conversationState: "IDLE",
      conversationContext: EMPTY_PENDING_CONTEXT,
    });
    pceLogger.incrementCounter("confirmation_rejected");
    return { handled: true, response: { text: prompt } };
  }

  if (confirmation.confirmed && !pendingActionId) {
    const prompt = "There is no pending action to confirm. Re-submit the change request first.";
    emitFinalEvent(eventBus, sessionId, startTime, prompt, {
      clarification: true,
      needsResponse: true,
      conversationState: "IDLE",
    });
    pceLogger.incrementCounter("confirmation_mismatch");
    return { handled: true, response: { text: prompt } };
  }

  const awaitingContext = {
    pendingAction,
    pendingActionId,
    pendingActionDigest: conversationContext?.pendingActionDigest,
    pendingActionCreatedAt,
    pendingActionSummary,
    pendingActionPreview,
    pendingActionExecuteInput,
    pendingActionExpiresAt,
  };
  const confirmationExtras = {
    clarification: true,
    needsResponse: true,
    conversationState: "AWAITING_CONFIRMATION" as const,
    conversationContext: awaitingContext,
    confirmationRequired: true,
    confirmationId: pendingActionId,
    confirmationPreview: pendingActionPreview ?? pendingActionSummary ?? pendingAction ?? "",
    confirmationExpiresAt: pendingActionExpiresAt ?? 0,
  };

  if (confirmation.confirmed && !confirmation.actionId && pendingActionId) {
    const prompt = `Pending change requires explicit confirmation. Reply with CONFIRM ${pendingActionId} to apply, or CANCEL.`;
    emitFinalEvent(eventBus, sessionId, startTime, prompt, confirmationExtras);
    pceLogger.incrementCounter("confirmation_mismatch");
    return { handled: true, response: { text: prompt } };
  }

  if (confirmation.confirmed && confirmation.actionId && pendingActionId && confirmation.actionId !== pendingActionId) {
    const prompt = `Confirmation id does not match the pending action. Reply with CONFIRM ${pendingActionId} to apply, or CANCEL.`;
    emitFinalEvent(eventBus, sessionId, startTime, prompt, confirmationExtras);
    pceLogger.incrementCounter("confirmation_mismatch");
    return { handled: true, response: { text: prompt } };
  }

  if (confirmation.confirmed && pendingActionExpired && pendingActionId) {
    const prompt = "Confirmation expired. Please re-request the change.";
    emitFinalEvent(eventBus, sessionId, startTime, prompt, {
      clarification: true,
      needsResponse: true,
      conversationState: "IDLE",
      conversationContext: EMPTY_PENDING_CONTEXT,
    });
    pceLogger.incrementCounter("confirmation_expired");
    return { handled: true, response: { text: prompt } };
  }

  if (
    confirmation.confirmed &&
    pendingActionExecuteInput &&
    pendingActionId &&
    confirmation.actionId === pendingActionId
  ) {
    pceLogger.incrementCounter("confirmation_approved");
    return {
      handled: false,
      effectiveInput: pendingActionExecuteInput,
      usedPendingAction: true,
    };
  }

  return {
    handled: false,
    effectiveInput: input.userInput,
    usedPendingAction: false,
  };
}
