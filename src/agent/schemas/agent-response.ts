import { z } from "zod";

export const AgentResponseSectionTypeSchema = z.enum([
  "text",
  "status",
  "facts",
  "table",
  "collection",
  "steps",
  "alert",
  "details",
  "connections",
]);

export const AgentResponseSectionSchema = z.object({
  type: AgentResponseSectionTypeSchema,
  title: z.string().optional(),
  data: z.unknown(),
});

export const AgentResponseSchema = z.object({
  version: z.literal("2"),
  conversation: z.object({
    state: z.enum(["IDLE", "NEED_CLARIFICATION", "AWAITING_CONFIRMATION", "READY_READ", "READY_WRITE"]),
    pendingActionId: z.string().optional(),
  }),
  answer: z.object({
    style: z.enum(["TERSE_DATA", "ASSISTIVE", "EXPLAINER"]),
    summary: z.string(),
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
  rawTextFallback: z.string(),
});

export type AgentResponse = z.infer<typeof AgentResponseSchema>;
export type AgentResponseSection = z.infer<typeof AgentResponseSectionSchema>;

export function createTextAgentResponse(
  text: string,
  options: {
    state?: AgentResponse["conversation"]["state"];
    style?: AgentResponse["answer"]["style"];
    pendingActionId?: string;
    traceId?: string;
  } = {}
): AgentResponse {
  const lines = text.split("\n");
  const summary = lines.shift() ?? "";
  const detail = lines.join("\n");
  return {
    version: "2",
    conversation: {
      state: options.state ?? "IDLE",
      ...(options.pendingActionId ? { pendingActionId: options.pendingActionId } : {}),
    },
    answer: {
      style: options.style ?? "ASSISTIVE",
      summary,
      sections: detail.trim()
        ? [{ type: "text", data: detail }]
        : [],
    },
    evidence: {
      toolCalls: [],
      ...(options.traceId ? { traceId: options.traceId } : {}),
    },
    rawTextFallback: text,
  };
}
