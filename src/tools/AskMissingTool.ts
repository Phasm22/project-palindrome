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

    const normalizedMissing = parsed.data.missing.map((slot) => slot.trim().toLowerCase());

    // Deterministic fast-paths for common slots to avoid LLM latency/hangs.
    if (normalizedMissing.includes("intent")) {
      return {
        data: {
          question:
            "What do you want to do next — observe status, diagnose a problem, make a change, or get an explanation?",
        },
      };
    }

    if (
      normalizedMissing.some((slot) =>
        ["target", "node", "host", "environment", "cluster", "destination"].includes(slot)
      )
    ) {
      return { data: { question: "What is the target environment for the VM?" } };
    }

    if (normalizedMissing.some((slot) => ["vmid", "resourceid", "resource_id"].includes(slot))) {
      return { data: { question: "Which VMID is this for?" } };
    }

    if (normalizedMissing.some((slot) => ["name", "vm_name", "hostname"].includes(slot))) {
      return { data: { question: "What should the VM be named?" } };
    }

    if (normalizedMissing.some((slot) => ["type", "vm_type", "template"].includes(slot))) {
      return { data: { question: "What type of VM do you want to create?" } };
    }

    const systemPrompt = `You ask a single, specific question to unblock an ops assistant.
Return one short question, no extra text.`;

    const userPrompt = `Intent: ${parsed.data.intent ?? "unknown"}
Missing: ${parsed.data.missing.join(", ")}
Context: ${parsed.data.context ?? "none"}`;

    try {
      const question = await runToolCompletion(systemPrompt, userPrompt, {
        temperature: 0.2,
        maxTokens: 120,
        timeoutMs: 8000,
      });
      return { data: { question } };
    } catch (error: any) {
      pceLogger.warn("ask_missing failed", { error: error.message });
      return { error: error.message ?? "ask_missing failed" };
    }
  }
}
