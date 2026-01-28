import { z } from "zod";
import { BaseTool } from "./BaseTool";
import type { ExecutionContext, ExecutionResult } from "../types";
import type { ToolSchema } from "./tool-schema";
import { createToolSchema } from "./tool-helpers";
import { runToolCompletion } from "./llm-tool-client";
import { pceLogger } from "../pce/utils/logger";

const SummarizeParams = z.object({
  observations: z.union([z.string(), z.array(z.string())]).describe("Raw observations to summarize."),
  intent: z.string().optional().describe("Intent label for context (optional)."),
});

/**
 * Summarize Observations Tool
 *
 * Produces a short evidence summary and anomaly callouts.
 */
export class SummarizeObservationsTool extends BaseTool {
  constructor() {
    super({
      name: "summarize_observations",
      description: "Summarize observations into 3 bullets with anomaly callouts.",
      categories: ["analysis", "summary"],
      allowedAcls: ["admin", "ops", "sre", "viewer"],
      risk: "low",
      requiresConfirmation: false,
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, SummarizeParams, {
      examples: [
        {
          description: "Summarize a metrics snapshot",
          parameters: {
            observations: [
              "CPU load spiked to 95% on node yin",
              "Disk usage 88% on /var/lib",
              "3 VMs reported IO wait > 20%",
            ],
            intent: "QUERY",
          },
        },
      ],
    });
  }

  async execute(params: Record<string, any>, context: ExecutionContext): Promise<ExecutionResult> {
    const parsed = SummarizeParams.safeParse(params);
    if (!parsed.success) {
      return { error: parsed.error.message };
    }

    const observations = Array.isArray(parsed.data.observations)
      ? parsed.data.observations.join("\n")
      : parsed.data.observations;

    const systemPrompt = `You summarize observations for an ops assistant.
Return a short list:
- 3 concise bullets
- If anomalies exist, add "Anomalies: ..." as a final bullet
No extra text.`;

    const userPrompt = `Intent: ${parsed.data.intent ?? "unknown"}
Observations:
${observations}`;

    try {
      const summary = await runToolCompletion(systemPrompt, userPrompt, { temperature: 0.2, maxTokens: 300 });
      return { data: { summary } };
    } catch (error: any) {
      pceLogger.warn("summarize_observations failed", { error: error.message });
      return { error: error.message ?? "summarize_observations failed" };
    }
  }
}
