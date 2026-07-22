import { generateObject } from "ai";
import { openai as aiSdkOpenai } from "@ai-sdk/openai";
import { z } from "zod";
import type { JoinedTrace } from "./trace-joiner";

export const JudgeVerdictSchema = z.object({
  verdict: z.enum(["supported", "unsupported", "partially_supported", "insufficient_data"]),
  claims: z.array(
    z.object({
      claim: z.string(),
      supportedBy: z.string().describe("Which tool result (or 'none') backs this claim"),
    })
  ),
  notes: z.string().optional(),
});

export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

const JUDGE_SYSTEM_PROMPT = [
  "You are a factuality judge for an infrastructure assistant.",
  "You will be given the user's question, the assistant's final answer, and the FULL raw data",
  "returned by every tool call made during that turn.",
  "Break the answer into its individual factual claims. For each claim, decide which tool result",
  "(if any) actually supports it. Do not use outside knowledge — only the tool data provided counts",
  "as support. A claim not backed by any tool result is unsupported, even if it sounds plausible.",
  "Set verdict to 'supported' only if every claim is backed by tool data, 'unsupported' if none are,",
  "'partially_supported' if some are and some aren't, and 'insufficient_data' if the tool calls",
  "returned too little to judge either way.",
].join(" ");

/**
 * Grades whether a trace's final answer is actually backed by the tool data
 * it had access to. Uses a separate model from the one being graded by
 * default (see judgeModelId) to avoid sharing blind spots — configurable
 * since a stronger judge costs more per call.
 */
export async function judgeTraceFactuality(
  joined: JoinedTrace,
  judgeModelId: string = "gpt-4o-mini"
): Promise<JudgeVerdict> {
  const toolData = joined.steps.flatMap((step) =>
    step.toolCalls.map((call) => ({
      toolName: call.toolName,
      parameters: call.parameters,
      success: call.result?.success,
      error: call.result?.error,
      // Prefer the full untruncated join result; fall back to the trace's own
      // truncated preview if no execution-store match was found for this call.
      data: call.fullResult?.data ?? call.result?.dataPreview,
    }))
  );

  const { object } = await generateObject({
    model: aiSdkOpenai(judgeModelId) as unknown as Parameters<typeof generateObject>[0]["model"],
    schema: JudgeVerdictSchema,
    system: JUDGE_SYSTEM_PROMPT,
    prompt: [
      `User question: ${joined.userInput}`,
      `Assistant's final answer: ${joined.finalResponse ?? "(none)"}`,
      `Tool call data: ${JSON.stringify(toolData, null, 2)}`,
    ].join("\n\n"),
  });

  return object;
}
