import { z } from "zod";

export const AgentResponseSectionSchema = z.object({
  type: z.enum(["facts", "table", "diff", "risk", "next_steps", "clarification", "confirmation"]),
  title: z.string().optional(),
  data: z.unknown(),
});

export const AgentResponseV1Schema = z.object({
  version: z.literal("1"),
  conversation: z.object({
    state: z.enum(["IDLE", "NEED_CLARIFICATION", "AWAITING_CONFIRMATION", "READY_READ", "READY_WRITE"]),
    pendingActionId: z.string().optional(),
  }),
  answer: z.object({
    style: z.enum(["TERSE_DATA", "ASSISTIVE", "EXPLAINER"]),
    summary: z.string().describe("One-sentence answer — always present"),
    sections: z.array(AgentResponseSectionSchema),
  }),
  evidence: z.object({
    toolCalls: z.array(
      z.object({
        tool: z.string(),
        ok: z.boolean(),
        durationMs: z.number().optional(),
        ref: z.string().optional(),
      })
    ),
    traceId: z.string().optional(),
  }),
  rawTextFallback: z.string().optional().describe(
    "Plain-text fallback for backward compatibility. Omit once UI fully consumes typed sections."
  ),
});

export type AgentResponseV1 = z.infer<typeof AgentResponseV1Schema>;
export type AgentResponseSection = z.infer<typeof AgentResponseSectionSchema>;
