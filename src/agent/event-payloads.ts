/**
 * Typed Zod schemas for AgentEvent.data payloads (Phase 2 — Structured Outputs).
 *
 * Each AgentEventType gets a corresponding typed payload.  The discriminated union
 * `AgentEventData` replaces the loose `Record<string, any>` on `AgentEvent.data`.
 */

import { z } from "zod";
import { AgentResponseV1Schema } from "./schemas/agent-response-v1";
import { ActionPlanSchema } from "./schemas/action-step";

// ---------------------------------------------------------------------------
// Tool events
// ---------------------------------------------------------------------------

export const ToolStartPayloadSchema = z
  .object({
  type: z.literal("tool:start"),
  toolName: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  toolCallId: z.string(),
})
  .passthrough();

export const ToolProgressPayloadSchema = z.object({
  type: z.literal("tool:progress"),
  toolName: z.string(),
  action: z.string().optional(),
  status: z.enum(["starting", "running", "waiting", "verifying", "completed", "failed"]),
  message: z.string(),
  progress: z.number().min(0).max(1).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const ToolCompletePayloadSchema = z
  .object({
  type: z.literal("tool:complete"),
  toolName: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  toolCallId: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  durationMs: z.number().optional(),
  dataPreview: z.string().optional(),
})
  .passthrough();

// ---------------------------------------------------------------------------
// LLM token / thinking events (opaque — just carry raw text)
// ---------------------------------------------------------------------------

export const LlmTokenPayloadSchema = z.object({
  type: z.literal("llm:token"),
  token: z.string(),
});

export const LlmThinkingPayloadSchema = z.object({
  type: z.literal("llm:thinking"),
  thinking: z.string(),
});

// ---------------------------------------------------------------------------
// Agent lifecycle events
// ---------------------------------------------------------------------------

export const AgentStepPayloadSchema = z
  .object({
  type: z.literal("agent:step"),
  step: z.number(),
  maxSteps: z.number(),
  userInput: z.string().optional(),
  intent: z.string().optional(),
  tool: z.string().optional(),
  mode: z.string().optional(),
})
  .passthrough();

export const AgentFinalPayloadSchema = z
  .object({
  type: z.literal("agent:final"),
  text: z.string(),
  totalSteps: z.number(),
  totalToolCalls: z.number(),
  durationMs: z.number(),
  // Optional fields present on some final events
  traceId: z.string().optional(),
  clarification: z.boolean().optional(),
  needsResponse: z.boolean().optional(),
  conversationState: z.string().optional(),
  conversationContext: z.record(z.string(), z.unknown()).optional(),
  pendingActionId: z.string().optional(),
  pendingActionSummary: z.string().optional(),
  pendingActionType: z.string().optional(),
  confirmationPrompt: z.string().optional(),
  confirmationRequired: z.boolean().optional(),
  memorySource: z.enum(["user_explicit", "policy_inference", "tool_verified"]).optional(),
  memoryConfidence: z.number().min(0).max(1).optional(),
  toolCalls: z
    .array(
      z.object({
        tool: z.string(),
        ok: z.boolean(),
        durationMs: z.number().optional(),
      })
    )
    .optional(),
  structuredResponse: AgentResponseV1Schema.optional(),
})
  .passthrough();

// ---------------------------------------------------------------------------
// Plan event (P3.3 — plan-before-execute)
// ---------------------------------------------------------------------------

export const AgentPlanPayloadSchema = z.object({
  type: z.literal("agent:plan"),
  plan: ActionPlanSchema,
  pendingConfirmationId: z.string(),
});

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export const AgentEventDataSchema = z.discriminatedUnion("type", [
  ToolStartPayloadSchema,
  ToolProgressPayloadSchema,
  ToolCompletePayloadSchema,
  LlmTokenPayloadSchema,
  LlmThinkingPayloadSchema,
  AgentStepPayloadSchema,
  AgentFinalPayloadSchema,
  AgentPlanPayloadSchema,
]);

export type ToolStartPayload = z.infer<typeof ToolStartPayloadSchema>;
export type ToolProgressPayload = z.infer<typeof ToolProgressPayloadSchema>;
export type ToolCompletePayload = z.infer<typeof ToolCompletePayloadSchema>;
export type LlmTokenPayload = z.infer<typeof LlmTokenPayloadSchema>;
export type LlmThinkingPayload = z.infer<typeof LlmThinkingPayloadSchema>;
export type AgentStepPayload = z.infer<typeof AgentStepPayloadSchema>;
export type AgentFinalPayload = z.infer<typeof AgentFinalPayloadSchema>;
export type AgentPlanPayload = z.infer<typeof AgentPlanPayloadSchema>;
export type AgentEventData = z.infer<typeof AgentEventDataSchema>;
