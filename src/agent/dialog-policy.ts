import type { IntentClassification } from "../reasoning/intent-classifier";
import type { ConversationState, UserPreferences } from "../types";
import type { RoutingDecision } from "../reasoning/intent-router";
import type { ResponseMode } from "./response-formatter";

export interface ConfirmationParseResult {
  confirmed: boolean;
  actionText?: string;
  actionId?: string;
  phrase?: string;
}

export interface DialogPolicyInput {
  intent: IntentClassification;
  routing?: RoutingDecision;
  conversationState?: ConversationState;
  userPreferences?: UserPreferences;
  confirmation?: ConfirmationParseResult;
  pendingActionId?: string;
  pendingActionCreatedAt?: number;
}

export interface DialogPolicyDecision {
  responseMode?: ResponseMode;
  nextState: ConversationState;
  needsClarification: boolean;
  requiresConfirmation: boolean;
  shouldExecute: boolean;
  decision: "EXECUTE" | "ASK_CLARIFY" | "ASK_CONFIRM" | "RESPOND_ONLY";
  reason?: string;
}

const CONFIRMATION_PATTERNS = [
  /^confirm\s*[:\s]+([a-z0-9_-]+)\b/i, // explicit confirmation id
  /^confirm\s*:\s*(.+)$/i,
  /^(?:confirm|apply|do it|doit|go ahead|proceed)\b(?:[:\s]+(.+))?$/i,
];

const CONFIRMATION_TTL_MS = 15 * 60 * 1000;

export function parseConfirmationInput(input: string): ConfirmationParseResult {
  const trimmed = input.trim();
  const idMatch = trimmed.match(CONFIRMATION_PATTERNS[0]);
  if (idMatch) {
    const actionId = idMatch[1]?.trim();
    return {
      confirmed: true,
      actionText: actionId || undefined,
      actionId: actionId || undefined,
      phrase: idMatch[0],
    };
  }

  for (const pattern of CONFIRMATION_PATTERNS.slice(1)) {
    const match = trimmed.match(pattern);
    if (match) {
      // Pattern-specific capture groups:
      // - /^confirm\s*:\s*(.+)$/ → match[1] is action text
      // - /^(?:confirm|apply|...)\b(?:[:\s]+(.+))?$/ → match[1] is optional action text
      const actionText = match[1]?.trim();
      return {
        confirmed: true,
        actionText: actionText || undefined,
        phrase: match[0],
      };
    }
  }
  return { confirmed: false };
}

export function selectResponseMode(
  intent: IntentClassification,
  prefs?: UserPreferences
): ResponseMode | undefined {
  if (prefs?.verbosity === "terse") return "TERSE_DATA";
  if (prefs?.verbosity === "assistive") return intent.intent === "CHAT_REASONING" ? "EXPLAINER" : "ASSISTIVE";
  if (prefs?.verbosity === "explainer") return "EXPLAINER";

  if (intent.intent === "QUERY") return "TERSE_DATA";
  if (intent.intent === "ACTION") return "TERSE_DATA";
  if (intent.intent === "CHAT_REASONING") return "EXPLAINER";
  if (intent.intent === "CHAT_SOCIAL" || intent.intent === "CLARIFICATION") return "ASSISTIVE";
  return "ASSISTIVE";
}

export function evaluateDialogPolicy(input: DialogPolicyInput): DialogPolicyDecision {
  const { intent, routing, userPreferences, confirmation, pendingActionId, pendingActionCreatedAt } = input;

  const needsClarification =
    intent.intent === "CLARIFICATION" ||
    (intent.missing && intent.missing.length > 0) ||
    routing?.route === "clarification";

  const requiresConfirmation =
    intent.intent === "ACTION" && (intent.risk === "WRITE_HIGH" || intent.risk === "DESTRUCTIVE");

  const isConfirmed = confirmation?.confirmed === true;
  const hasPendingAction = !!pendingActionId;
  const isPendingActionFresh =
    pendingActionCreatedAt ? (Date.now() - pendingActionCreatedAt) <= CONFIRMATION_TTL_MS : false;
  const confirmationMatchesPending =
    hasPendingAction && !!confirmation?.actionId && confirmation.actionId === pendingActionId;
  const confirmationAllowed =
    intent.risk === "DESTRUCTIVE"
      ? (confirmationMatchesPending && isPendingActionFresh)
      : (isConfirmed && (!hasPendingAction || isPendingActionFresh));

  let nextState: ConversationState = "READY_READ";
  if (needsClarification) nextState = "NEED_CLARIFICATION";
  else if (requiresConfirmation && !confirmationAllowed) nextState = "AWAITING_CONFIRMATION";
  else if (intent.intent === "ACTION") nextState = "READY_WRITE";
  else nextState = "READY_READ";

  const responseMode = needsClarification || (requiresConfirmation && !confirmationAllowed)
    ? "ASSISTIVE"
    : selectResponseMode(intent, userPreferences);

  const shouldExecute = !needsClarification && (!requiresConfirmation || confirmationAllowed);
  const decision = needsClarification
    ? "ASK_CLARIFY"
    : requiresConfirmation && !confirmationAllowed
      ? "ASK_CONFIRM"
      : shouldExecute
        ? "EXECUTE"
        : "RESPOND_ONLY";

  return {
    responseMode,
    nextState,
    needsClarification,
    requiresConfirmation,
    shouldExecute,
    decision,
    reason: needsClarification
      ? "Missing slots or low confidence"
      : requiresConfirmation && !confirmationAllowed
        ? "Awaiting explicit confirmation"
        : "Ready",
  };
}
