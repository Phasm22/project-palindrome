export type ConversationState =
  | "IDLE"
  | "NEED_CLARIFICATION"
  | "READY_READ"
  | "READY_WRITE"
  | "AWAITING_CONFIRMATION"
  | "EXECUTED"
  | "FOLLOWUP";

export type VerbosityPreference = "terse" | "assistive" | "explainer";

export interface UserPreferences {
  safeMode?: boolean;
  defaultEnv?: string;
  preferredTimeRange?: string;
  verbosity?: VerbosityPreference;
}

export type MemoryUpdateSource = "user_explicit" | "policy_inference" | "tool_verified";

export interface ConversationContext {
  activeHost?: string;
  activeService?: string;
  lastIncidentSignature?: string;
  userName?: string;
  pendingAction?: string;
  pendingActionId?: string;
  pendingActionDigest?: string;
  pendingActionCreatedAt?: number;
  pendingActionSummary?: string;
}
