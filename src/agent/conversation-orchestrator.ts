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
    const verb = intent.operation.verbs[0] ?? "change";
    const normalizedInput = userInput.trim();

    const isCreateVmAction =
      verb === "create" &&
      ((intent.metadata?.domain === "compute") || /\b(vm|virtual machine)\b/i.test(normalizedInput));
    if (isCreateVmAction) {
      const vmNameMatch = normalizedInput.match(/\b(?:named|called)\s+([a-z0-9][a-z0-9._-]*)\b/i);
      const nodeMatch = normalizedInput.match(/\b(?:on|in)\s+(?:node\s+)?([a-z0-9][a-z0-9._-]*)\b/i);
      const vmName = vmNameMatch?.[1];
      const node = nodeMatch?.[1] ?? intent.entities.hosts[0];
      const parts = ["create VM"];
      if (vmName) parts.push(vmName);
      if (node) parts.push(`on ${node}`);
      return parts.join(" ");
    }

    // Extract the target name the user actually typed (word right after the verb)
    const verbTargetMatch = normalizedInput.match(
      /\b(?:destroy|delete|remove|terminate|kill|stop|start|restart|reboot)\s+(?:(?:vm|virtual\s+machine|container|lxc)\s+)?([\w][\w.-]*)\b/i
    );
    const targetName = verbTargetMatch?.[1];

    const vmid = intent.entities.resourceIds[0];
    // Node is any host that is not the typed target name
    const node = intent.entities.hosts.find(
      h => h.toLowerCase() !== (targetName?.toLowerCase() ?? "")
    );

    const parts: string[] = [verb];
    if (targetName) {
      parts.push(vmid ? `${targetName} (VMID ${vmid})` : targetName);
    } else if (vmid) {
      parts.push(`VMID ${vmid}`);
    } else if (intent.entities.hosts[0] && intent.entities.hosts[0].toLowerCase() !== (node?.toLowerCase() ?? "")) {
      parts.push(intent.entities.hosts[0]);
    } else if (intent.entities.services[0]) {
      parts.push(intent.entities.services[0]);
    }
    if (node) {
      parts.push(`on ${node}`);
    }

    if (parts.length > 1) return parts.join(" ");
    return `${verb} (target needed)`;
  }
  return userInput;
}
