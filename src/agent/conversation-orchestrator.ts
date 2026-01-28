import type { IntentClassification } from "../reasoning/intent-classifier";
import type { ConversationContext, ConversationState, UserPreferences } from "../types";
import type { RoutingDecision } from "../reasoning/intent-router";
import type { ResponseMode } from "./response-formatter";
import { evaluateDialogPolicy, parseConfirmationInput, type ConfirmationParseResult, type DialogPolicyDecision } from "./dialog-policy";

export interface OrchestratorInput {
  userInput: string;
  intent: IntentClassification;
  routing?: RoutingDecision;
  conversationState?: ConversationState;
  conversationContext?: ConversationContext;
  userPreferences?: UserPreferences;
  confirmation?: ConfirmationParseResult;
}

export interface OrchestratorDecision extends DialogPolicyDecision {
  responseMode?: ResponseMode;
  pendingAction?: string;
  confirmation?: ReturnType<typeof parseConfirmationInput>;
}

export function planConversation(input: OrchestratorInput): OrchestratorDecision {
  const confirmation = input.confirmation ?? parseConfirmationInput(input.userInput);
  const policy = evaluateDialogPolicy({
    intent: input.intent,
    routing: input.routing,
    conversationState: input.conversationState,
    userPreferences: input.userPreferences,
    confirmation,
    pendingActionId: input.conversationContext?.pendingActionId,
    pendingActionCreatedAt: input.conversationContext?.pendingActionCreatedAt,
  });

  const pendingAction = policy.requiresConfirmation && !confirmation.confirmed
    ? summarizePendingAction(input.intent, input.userInput)
    : undefined;

  return {
    ...policy,
    confirmation,
    pendingAction,
  };
}

function summarizePendingAction(intent: IntentClassification, userInput: string): string {
  if (intent.operation?.verbs?.length) {
    const verb = intent.operation.verbs[0];
    const target = intent.entities.resourceIds[0] || intent.entities.hosts[0] || intent.entities.services[0];
    if (target) {
      return `${verb} ${target}`;
    }
    return `${verb} (target needed)`;
  }
  return userInput;
}

