import { z } from "zod";
import { BaseTool } from "./BaseTool";
import type { ExecutionContext, ExecutionResult } from "../types";
import type { ToolSchema } from "./tool-schema";
import { createToolSchema } from "./tool-helpers";
import { runToolCompletion } from "./llm-tool-client";
import { pceLogger } from "../pce/utils/logger";

const NextStepsParams = z.object({
  intent: z.string().describe("Intent label (QUERY/ACTION/CHAT_REASONING/etc.)."),
  observations: z.union([z.string(), z.array(z.string())]).describe("Observation summary or raw output."),
});

/**
 * Next Steps Tool
 *
 * Suggests 1-3 ranked actions based on intent + observations.
 */
export class NextStepsTool extends BaseTool {
  constructor() {
    super({
      name: "next_steps",
      description: "Generate 1-3 ranked next actions based on intent and observations.",
      categories: ["analysis", "planning"],
      allowedAcls: ["admin", "ops", "sre", "viewer"],
      risk: "low",
      requiresConfirmation: false,
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, NextStepsParams, {
      examples: [
        {
          description: "Suggest next steps for a CPU spike",
          parameters: {
            intent: "QUERY",
            observations: "CPU load 95% on node yin for last 15m",
          },
        },
      ],
    });
  }

  async execute(params: Record<string, any>, context: ExecutionContext): Promise<ExecutionResult> {
    const parsed = NextStepsParams.safeParse(params);
    if (!parsed.success) {
      return { error: parsed.error.message };
    }

    const observations = Array.isArray(parsed.data.observations)
      ? parsed.data.observations.join("\n")
      : parsed.data.observations;

    const systemPrompt = `You are an ops assistant. Suggest 1-3 next actions.
Return JSON only: {"steps":["...","..."]}.`;

    const userPrompt = `Intent: ${parsed.data.intent}
Observations:
${observations}`;

    try {
      const content = await runToolCompletion(systemPrompt, userPrompt, { temperature: 0.2, maxTokens: 300 });
      let steps: string[] = [];
      try {
        const parsedJson = JSON.parse(content);
        if (Array.isArray(parsedJson.steps)) {
          steps = parsedJson.steps.filter((step: any) => typeof step === "string");
        }
      } catch {
        steps = content
          .split("\n")
          .map(line => line.replace(/^[-*\d.\s]+/, "").trim())
          .filter(Boolean)
          .slice(0, 3);
      }
      return { data: { steps } };
    } catch (error: any) {
      pceLogger.warn("next_steps failed", { error: error.message });
      return { error: error.message ?? "next_steps failed" };
    }
  }
}
