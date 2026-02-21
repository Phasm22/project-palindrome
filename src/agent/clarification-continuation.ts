import type { ConversationState } from "../types";

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ClarificationContinuationResult {
  effectiveInput: string;
  usedContinuation: boolean;
  anchorUserInput?: string;
}

const ACTION_PREFIX_PATTERN =
  /^(create|destroy|delete|remove|terminate|list|show|restart|start|stop|reboot|configure|set|apply|run|deploy|provision|what|how|why|when|where|which|can|could|should|please)\b/i;

function normalizeSpaces(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isLikelyClarificationFragment(input: string): boolean {
  const trimmed = normalizeSpaces(input);
  if (!trimmed) return false;
  if (trimmed.length > 64) return false;
  if (trimmed.includes("?")) return false;

  const tokens = trimmed.split(" ");
  if (tokens.length > 6) return false;
  if (ACTION_PREFIX_PATTERN.test(trimmed)) return false;

  return true;
}

function findClarificationAnchor(history: ConversationMessage[]): string | null {
  const userMessages = history
    .filter((message) => message.role === "user")
    .map((message) => normalizeSpaces(message.content))
    .filter(Boolean);

  if (userMessages.length === 0) return null;

  for (let i = userMessages.length - 1; i >= 0; i--) {
    const candidate = userMessages[i];
    if (!candidate) continue;
    if (!isLikelyClarificationFragment(candidate)) {
      return candidate;
    }
  }

  return userMessages[userMessages.length - 1] ?? null;
}

function findLastAssistantPrompt(history: ConversationMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (!message || message.role !== "assistant") continue;
    const normalized = normalizeSpaces(message.content);
    if (normalized) return normalized;
  }
  return null;
}

export function resolveClarificationContinuationInput(params: {
  userInput: string;
  conversationState?: ConversationState;
  conversationHistory?: ConversationMessage[];
}): ClarificationContinuationResult {
  const trimmedInput = normalizeSpaces(params.userInput);

  if (params.conversationState !== "NEED_CLARIFICATION") {
    return { effectiveInput: trimmedInput, usedContinuation: false };
  }

  if (!isLikelyClarificationFragment(trimmedInput)) {
    return { effectiveInput: trimmedInput, usedContinuation: false };
  }

  const history = params.conversationHistory ?? [];
  const anchorUserInput = findClarificationAnchor(history);
  if (!anchorUserInput) {
    return { effectiveInput: trimmedInput, usedContinuation: false };
  }

  if (normalizeSpaces(anchorUserInput).toLowerCase() === trimmedInput.toLowerCase()) {
    return { effectiveInput: trimmedInput, usedContinuation: false };
  }

  const anchorLower = anchorUserInput.toLowerCase();
  const assistantPrompt = findLastAssistantPrompt(history)?.toLowerCase() ?? "";
  const asksForEnvironment = /\b(target|environment|node|host|cluster|destination)\b/.test(assistantPrompt);
  const isCreateVmAnchor =
    /\b(create|make|provision|spin up)\b/.test(anchorLower) &&
    /\b(vm|virtual machine)\b/.test(anchorLower);
  const anchorAlreadyHasNodeClause = /\b(on|in)\s+(?:node\s+)?[a-z0-9\-_]+\b/.test(anchorLower);

  const effectiveInput = asksForEnvironment && isCreateVmAnchor && !anchorAlreadyHasNodeClause
    ? `${anchorUserInput} on ${trimmedInput}`
    : `${anchorUserInput} ${trimmedInput}`;

  return {
    effectiveInput,
    usedContinuation: true,
    anchorUserInput,
  };
}
