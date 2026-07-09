/**
 * P3.3: Plan-before-execute for multi-step ACTION intents.
 *
 * Generates a structured ActionPlan via generateObject() before entering the
 * main LLM loop. Returns null on failure — callers fall through to direct execution.
 */

import { generateObject } from "ai";
import { openai as aiSdkOpenai } from "@ai-sdk/openai";
import { ActionPlanSchema, type ActionPlan } from "../schemas/action-step";
import { actionRegistry } from "../../actions/registry";
import { generateActionParamsDoc } from "../../actions/action-docs-generator";
import { logger } from "../../utils/logger";

export interface PlanGeneratorInput {
  userInput: string;
  sessionId: string;
}

/**
 * Calls gpt-4o-mini to produce a structured ActionPlan for the given user
 * request. Non-fatal: returns null if generation fails for any reason.
 */
export async function generateActionPlan(
  input: PlanGeneratorInput
): Promise<ActionPlan | null> {
  const { userInput, sessionId } = input;

  try {
    const actions = actionRegistry.list();
    const actionDocs = generateActionParamsDoc(actions);

    const result = await generateObject({
      model: aiSdkOpenai("gpt-4o-mini"),
      schema: ActionPlanSchema,
      prompt: `You are a planning agent for an infrastructure automation system. Given the user's request, generate a structured execution plan.

User request: ${userInput}

Available actions:
${actionDocs}

Generate a plan with numbered steps. Each step should specify:
- The action to take (must be one of the available actions above)
- Parameters needed
- Risk level
- Whether confirmation is required before execution

Only include steps that are actually needed. For simple single-step operations, include just one step.`,
    });

    return result.object;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("generateActionPlan failed — falling through to direct execution", {
      sessionId,
      error: message,
    });
    // Non-fatal: return null so caller falls through to the normal LLM loop
    return null;
  }
}
