/**
 * Handles ASK_CLARIFY when domain detectors did not bypass: intent disambiguation,
 * ask_missing for missing slots, or generic "observe/diagnose/change" disambiguation.
 */

import type { IntentClassification } from "../../reasoning/intent-classifier";
import type { RoutingDecision } from "../../reasoning/intent-router";
import type { ConversationContext } from "../../types";
import type { AgentEventBus } from "../event-bus";
import type { BaseTool } from "../../tools/BaseTool";
import type { ExecutionResult } from "../../types/execution";
import { emitFinalEvent } from "./emit-helpers";
import { executeToolCall } from "../tool-executor";
import { logger } from "../../utils/logger";

export interface HandleClarifyFromPlanInput {
  originalUserInput: string;
  userInput: string;
  classification: IntentClassification;
  routing: RoutingDecision;
  contextUpdate: ConversationContext;
  nextState: string;
  tools: BaseTool[];
  execContext: { userId: string; aclGroup: string };
  eventBus: AgentEventBus;
  sessionId: string;
  startTime: number;
}

export interface HandleClarifyFromPlanResult {
  text: string;
}

/**
 * Run clarification flow for ASK_CLARIFY when domain detectors did not bypass.
 * Returns the clarification message text (intent disambiguation, ask_missing result, or generic).
 */
export async function handleClarifyFromPlan(
  input: HandleClarifyFromPlanInput
): Promise<HandleClarifyFromPlanResult> {
  const {
    originalUserInput,
    classification,
    routing,
    contextUpdate,
    nextState,
    tools,
    execContext,
    eventBus,
    sessionId,
    startTime,
  } = input;

  if (classification.missing.length === 1 && classification.missing[0] === "intent") {
    const disambiguation =
      "What do you want to do next — observe status, diagnose a problem, make a change, or get an explanation?";
    emitFinalEvent(eventBus, sessionId, startTime, disambiguation, {
      clarification: true,
      needsResponse: true,
      classification,
      conversationState: nextState,
      conversationContext: contextUpdate,
    });
    return { text: disambiguation };
  }

  if (classification.missing.length > 0) {
    let clarificationQuestion = "Could you clarify the missing details?";
    try {
      const toolResult = (await executeToolCall(
        {
          toolName: "ask_missing",
          parameters: {
            missing: classification.missing,
            intent: classification.intent,
            context: `Input: ${originalUserInput}`,
          },
        },
        tools,
        execContext
      )) as ExecutionResult;
      const question = toolResult?.data?.question;
      if (typeof question === "string" && question.trim().length > 0) {
        clarificationQuestion = question.trim();
      }
    } catch (error: unknown) {
      logger.warn("ask_missing tool failed, using fallback clarification", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    emitFinalEvent(eventBus, sessionId, startTime, clarificationQuestion, {
      clarification: true,
      needsResponse: true,
      classification,
      conversationState: nextState,
      conversationContext: contextUpdate,
    });
    return { text: clarificationQuestion };
  }

  if (routing.route === "clarification") {
    const disambiguation =
      "Are you asking to observe, diagnose, change, explain, or plan? Please specify.";
    emitFinalEvent(eventBus, sessionId, startTime, disambiguation, {
      clarification: true,
      needsResponse: true,
      classification,
      conversationState: nextState,
      conversationContext: contextUpdate,
    });
    return { text: disambiguation };
  }

  // Fallback (should not be reached when called from ASK_CLARIFY branch)
  const fallback = "Could you clarify what you'd like to know or do?";
  emitFinalEvent(eventBus, sessionId, startTime, fallback, {
    clarification: true,
    needsResponse: true,
    classification,
    conversationState: nextState,
    conversationContext: contextUpdate,
  });
  return { text: fallback };
}
