import type { IntentClassification } from "../reasoning/intent-classifier";
import type { ConversationContext, ConversationState, UserPreferences } from "../types";
import type { RoutingDecision } from "../reasoning/intent-router";
import type { ResponseMode } from "./response-formatter";
import { evaluateDialogPolicy, parseConfirmationInput, type ConfirmationParseResult, type DialogPolicyDecision } from "./dialog-policy";
import type { HistoricalScore } from "./historical-scorer";
import type { HistoricalScorer } from "./historical-scorer";
import {
  parseCompoundApplicationRequest,
  summarizeCompoundApplicationRequest,
} from "./application-request";
import { isPlausibleVmIdentifier } from "../actions/helpers/identifier-validation";

export interface OrchestratorInput {
  userInput: string;
  intent: IntentClassification;
  routing?: RoutingDecision;
  conversationState?: ConversationState;
  conversationContext?: ConversationContext;
  userPreferences?: UserPreferences;
  confirmation?: ConfirmationParseResult;
  score?: HistoricalScore;
  scorer?: HistoricalScorer;
}

export interface OrchestratorDecision extends DialogPolicyDecision {
  responseMode?: ResponseMode;
  pendingAction?: string;
  confirmation?: ReturnType<typeof parseConfirmationInput>;
  score?: HistoricalScore;
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
    score: input.score,
    scorer: input.scorer,
  });

  const pendingAction = policy.requiresConfirmation && !confirmation.confirmed
    ? summarizePendingAction(input.intent, input.userInput)
    : undefined;

  return {
    ...policy,
    confirmation,
    pendingAction,
    score: input.score,
  };
}

export function summarizePendingAction(intent: IntentClassification, userInput: string): string {
  const applicationRequest = parseCompoundApplicationRequest(userInput);
  if (applicationRequest) {
    return summarizeCompoundApplicationRequest(applicationRequest);
  }

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

    // Extract the target name the user actually typed (word right after the verb).
    // Garbled/adversarial input (e.g. a Cypher-injection fragment) can leave
    // a stray single-character token right after a destroy verb (see H-05);
    // gate the raw regex capture — and the LLM classifier's own `hosts`
    // entities, which can independently latch onto the same implausible
    // token — through the same plausibility guard already used to fail
    // resolution closed downstream (identifier-validation.ts), so an
    // implausible "target" never even reaches the confirmation prompt.
    const verbTargetMatch = normalizedInput.match(
      /\b(?:destroy|delete|remove|terminate|kill|stop|start|restart|reboot)\s+(?:(?:vm|virtual\s+machine|container|lxc)\s+)?([\w][\w.-]*)\b/i
    );
    const rawTargetName = verbTargetMatch?.[1];
    const targetName = rawTargetName && isPlausibleVmIdentifier(rawTargetName) ? rawTargetName : undefined;
    const plausibleHosts = intent.entities.hosts.filter(isPlausibleVmIdentifier);

    const vmid = intent.entities.resourceIds.find((resourceId) => /^\d+$/.test(resourceId));
    // Node is any plausible host that is not the typed target name
    const rawNode = plausibleHosts.find(
      h => h.toLowerCase() !== (targetName?.toLowerCase() ?? "")
    );
    const node = rawNode?.toLowerCase() === "yang"
      ? "YANG"
      : rawNode?.toLowerCase() === "proxbig"
        ? "proxBig"
        : rawNode;

    const parts: string[] = [verb];
    if (targetName) {
      parts.push(vmid ? `${targetName} (VMID ${vmid})` : targetName);
    } else if (vmid) {
      parts.push(`VMID ${vmid}`);
    } else if (plausibleHosts[0] && plausibleHosts[0].toLowerCase() !== (node?.toLowerCase() ?? "")) {
      parts.push(plausibleHosts[0]);
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
