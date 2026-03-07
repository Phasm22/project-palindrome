/**
 * Agent handlers: confirmation, identity/social, confirm-request, clarify, execute.
 */

export { handleExecute } from "./handle-execute";
export type { HandleExecuteInput } from "./handle-execute";

export { handleConfirmation } from "./handle-confirmation";
export type { HandleConfirmationInput, HandleConfirmationResult } from "./handle-confirmation";

export { handleIdentityAndSocial } from "./handle-identity";
export type { HandleIdentityInput, HandleIdentityResult } from "./handle-identity";

export { handleConfirmRequest } from "./handle-confirm-request";
export type {
  HandleConfirmRequestInput,
  HandleConfirmRequestResult,
  PendingActionRecord,
} from "./handle-confirm-request";

export { handleClarifyFromPlan } from "./handle-clarify";
export type {
  HandleClarifyFromPlanInput,
  HandleClarifyFromPlanResult,
} from "./handle-clarify";

export { emitStepEvent, emitFinalEvent } from "./emit-helpers";
export type { AgentStepEventData } from "./emit-helpers";

export { parseToolArgs } from "./parse-tool-args";
export type { ParseToolArgsResult } from "./parse-tool-args";

export {
  extractUserNameUpdate,
  isUserNameQuery,
  isAssistantNameQuery,
  isMetaIdentityQuery,
} from "./identity-helpers";

export {
  buildPendingActionRecord,
  summarizeToolCall,
  inferMissingToolSlots,
  cleanupAfterProxmoxDestroy,
} from "./tool-helpers";
