/**
 * Example Integration: Using Intent Classifier in Agent Runner
 * 
 * This shows how to replace the old clarification check with the new
 * probabilistic intent classification system.
 */

import { classifyAndRoute, type RoutingDecision } from "./intent-router";
import { logger } from "../utils/logger";

/**
 * Example: Replace the clarification check in runAgent()
 * 
 * OLD APPROACH (fragile):
 * ```typescript
 * const clarificationResult = analyzeInput(userInput);
 * if (clarificationResult.needsClarification) {
 *   return { text: formatClarificationMessage(clarificationResult) };
 * }
 * ```
 * 
 * NEW APPROACH (robust):
 */
export async function handleUserInput(userInput: string): Promise<{
  needsClarification: boolean;
  clarificationMessage?: string;
  routing?: RoutingDecision;
  proceedToLLM: boolean;
}> {
  // Classify and route in one step
  const { classification, routing } = classifyAndRoute(userInput);
  
  logger.info("Intent classification", {
    input: userInput.slice(0, 50),
    type: classification.type,
    confidence: classification.confidence,
    metadata: classification.metadata,
    route: routing.route,
  });
  
  // Handle clarification requests
  if (routing.route === "clarification") {
    return {
      needsClarification: true,
      clarificationMessage: generateClarificationPrompt(userInput, classification),
      proceedToLLM: false,
    };
  }
  
  // Fast path: direct handlers (if implemented)
  if (routing.route === "direct_handler") {
    // Could execute handler here, or still route to LLM with context
    logger.info("Direct handler available", {
      handler: routing.handler,
      intent: routing.intent,
    });
    // For now, still route to LLM but with better context
    return {
      needsClarification: false,
      routing,
      proceedToLLM: true,
    };
  }
  
  // Default: route to LLM reasoning
  return {
    needsClarification: false,
    routing,
    proceedToLLM: true,
  };
}

/**
 * Generate clarification prompt based on classification
 */
function generateClarificationPrompt(
  userInput: string,
  classification: any
): string {
  if (classification.confidence < 0.2) {
    return "I'm not sure what you're asking. Could you rephrase your question?";
  }
  
  // Could provide suggestions based on classification metadata
  const suggestions: string[] = [];
  
  if (classification.metadata?.domain === "metrics") {
    suggestions.push("Are you asking about temperature, CPU, memory, or status?");
  }
  
  if (classification.metadata?.domain === "compute") {
    suggestions.push("Are you asking about VMs, containers, or nodes?");
  }
  
  if (suggestions.length > 0) {
    return `I understand you're asking about ${classification.metadata.domain}, but could you be more specific?\n\n${suggestions.join("\n")}`;
  }
  
  return "Could you clarify what you'd like to know or do?";
}

/**
 * Example: Enhanced system prompt with intent context
 */
export function enhanceSystemPromptWithIntent(
  basePrompt: string,
  classification: any,
  routing: RoutingDecision
): string {
  let intentContext = "";
  
  if (classification.type === "QUERY" && classification.metadata?.queryType) {
    intentContext += `\n\n**User Intent**: Informational query about ${classification.metadata.queryType}`;
    if (classification.metadata.domain) {
      intentContext += ` in the ${classification.metadata.domain} domain`;
    }
    intentContext += `. Use appropriate query tools (twin_query, proxmox_readonly, etc.).`;
  }
  
  if (classification.type === "ACTION" && classification.metadata?.actionType) {
    intentContext += `\n\n**User Intent**: Action request to ${classification.metadata.actionType}`;
    if (routing.intent) {
      intentContext += `. Parsed intent: ${JSON.stringify(routing.intent)}`;
    }
    intentContext += `. Use action tool or proxmox_write as appropriate.`;
  }
  
  if (classification.confidence < 0.7) {
    intentContext += `\n\n**Note**: Intent classification confidence is ${classification.confidence.toFixed(2)}. If the user's request doesn't match the classified intent, adapt accordingly.`;
  }
  
  return basePrompt + intentContext;
}

