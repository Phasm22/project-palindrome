import { z } from "zod";
import { BaseTool } from "./BaseTool";
import type { ExecutionContext, ExecutionResult } from "../types";
import type { ToolSchema } from "./tool-schema";
import { createToolSchema } from "./tool-helpers";
import { runToolCompletion } from "./llm-tool-client";
import { pceLogger } from "../pce/utils/logger";

const AskMissingParams = z.object({
  missing: z.array(z.string()).describe("List of missing slots."),
  intent: z.string().optional().describe("Intent label (optional)."),
  context: z.string().optional().describe("Additional context to inform the question."),
});

/**
 * Ask Missing Tool
 *
 * Produces the single best question to unblock the action.
 */
export class AskMissingTool extends BaseTool {
  constructor() {
    super({
      name: "ask_missing",
      description: "Generate the single best clarification question from missing slots.",
      categories: ["clarification"],
      allowedAcls: ["admin", "ops", "sre", "viewer"],
      risk: "low",
      requiresConfirmation: false,
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, AskMissingParams, {
      examples: [
        {
          description: "Ask for missing target",
          parameters: {
            missing: ["target"],
            intent: "ACTION",
            context: "User requested restart",
          },
        },
      ],
    });
  }

  async execute(params: Record<string, any>, context: ExecutionContext): Promise<ExecutionResult> {
    const parsed = AskMissingParams.safeParse(params);
    if (!parsed.success) {
      return { error: parsed.error.message };
    }

    const systemPrompt = `You ask a single, specific question to unblock an ops assistant.
Return one short question, no extra text.`;

    const userPrompt = `Intent: ${parsed.data.intent ?? "unknown"}
Missing: ${parsed.data.missing.join(", ")}
Context: ${parsed.data.context ?? "none"}`;

    try {
      const question = await runToolCompletion(systemPrompt, userPrompt, { temperature: 0.2, maxTokens: 120 });
      return { data: { question } };
    } catch (error: any) {
      pceLogger.warn("ask_missing failed", { error: error.message });
      return { error: error.message ?? "ask_missing failed" };
    }
  }
}
