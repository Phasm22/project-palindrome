/**
 * Failure-Aware Intent Reclassification
 * 
 * When a tool execution fails, we don't retry blindly. Instead, we reclassify
 * the intent with context (error message, partial state) to make better decisions.
 * 
 * This prevents retry loops:
 * - failed → retry → failed → retry
 * 
 * Instead:
 * - failed → reclassify with context → new approach → success/failure
 */

import { classifyIntent } from "./intent-classifier";
import type { IntentClassification, IntentType } from "./intent-classifier";
import { routeIntent } from "./intent-router";
import type { RoutingDecision } from "./intent-router";
import { logger } from "../utils/logger";

export interface FailureContext {
  error: string;
  toolName: string;
  parameters?: Record<string, any>;
  partialState?: Record<string, any>; // Any partial results or state from failed attempt
  attemptNumber: number;
  previousAttempts?: Array<{
    toolName: string;
    error: string;
    attemptNumber: number;
  }>;
}

export interface ReclassificationResult {
  classification: IntentClassification;
  routing: RoutingDecision;
  shouldRetry: boolean;
  reason: string;
  suggestedAction?: string;
  confidenceAdjusted: boolean; // True if confidence was capped to prevent ratcheting
}

/**
 * Reclassify intent with failure context
 * 
 * This enriches the user input with error context and reclassifies,
 * allowing the system to make better decisions about next steps.
 * 
 * IMPORTANT: Confidence is monotonic - it cannot increase unless there's
 * genuinely new evidence. This prevents "ratcheting" into unsafe zones.
 * 
 * @param originalInput - The original user input
 * @param failureContext - Context about the failure
 * @param originalClassification - The original classification (for confidence capping)
 * @param classifyFn - Optional async classifier (e.g. classifyIntentWithLLM); when provided, used instead of sync classifyIntent
 */
export async function reclassifyIntentWithContext(
  originalInput: string,
  failureContext: FailureContext,
  originalClassification?: IntentClassification,
  classifyFn?: (input: string) => Promise<IntentClassification>
): Promise<ReclassificationResult> {
  const { error, toolName, parameters, partialState, attemptNumber, previousAttempts = [] } = failureContext;
  
  // Build enriched input with context
  const contextParts: string[] = [];
  
  // Add original input
  contextParts.push(`Original request: ${originalInput}`);
  
  // Add error context
  contextParts.push(`Previous attempt failed: ${error}`);
  contextParts.push(`Failed tool: ${toolName}`);
  
  // Add attempt tracking
  if (attemptNumber > 1) {
    contextParts.push(`This is attempt ${attemptNumber}`);
    if (previousAttempts.length > 0) {
      const previousErrors = previousAttempts
        .map(a => `Attempt ${a.attemptNumber}: ${a.toolName} failed with "${a.error}"`)
        .join("; ");
      contextParts.push(`Previous attempts: ${previousErrors}`);
    }
  }
  
  // Add partial state if available
  if (partialState && Object.keys(partialState).length > 0) {
    const stateSummary = Object.entries(partialState)
      .map(([key, value]) => {
        const valueStr = typeof value === 'object' ? JSON.stringify(value).slice(0, 100) : String(value);
        return `${key}: ${valueStr}`;
      })
      .join(", ");
    contextParts.push(`Partial state: ${stateSummary}`);
  }
  
  // Add parameters that were attempted
  if (parameters && Object.keys(parameters).length > 0) {
    const paramSummary = Object.entries(parameters)
      .map(([key, value]) => {
        const valueStr = typeof value === 'object' ? JSON.stringify(value).slice(0, 50) : String(value);
        return `${key}=${valueStr}`;
      })
      .join(", ");
    contextParts.push(`Attempted parameters: ${paramSummary}`);
  }
  
  // Create enriched input for reclassification
  const enrichedInput = contextParts.join(". ");
  
  // Reclassify with enriched context (LLM when classifyFn provided, else sync classifier)
  let classification = classifyFn
    ? await classifyFn(enrichedInput)
    : classifyIntent(enrichedInput);
  
  // CRITICAL: Make confidence monotonic - don't allow it to increase unless
  // there's genuinely new evidence (not just error messages)
  let confidenceAdjusted = false;
  if (originalClassification) {
    const originalConfidence = originalClassification.confidence;
    const newConfidence = classification.confidence;
    
    // Check if there's genuinely new evidence that would justify higher confidence
    const hasNewEvidence = hasGenuineNewEvidence(partialState, error, originalInput, enrichedInput);
    
    if (newConfidence > originalConfidence && !hasNewEvidence) {
      // Cap confidence to original - prevent ratcheting into unsafe zones
      classification = {
        ...classification,
        confidence: originalConfidence,
      };
      confidenceAdjusted = true;
      
      logger.warn(`Capped confidence to prevent ratcheting`, {
        originalConfidence,
        newConfidence,
        originalInput,
        reason: "No genuinely new evidence to justify confidence increase",
      });
    }
  }
  
  const routing = routeIntent(enrichedInput, classification);
  
  // Determine if we should retry
  const shouldRetry = shouldRetryAfterFailure(
    attemptNumber,
    previousAttempts.length,
    error,
    classification,
    routing
  );
  
  // Generate reason and suggested action
  const reason = generateFailureReason(attemptNumber, error, toolName, classification, routing);
  const suggestedAction = generateSuggestedAction(error, toolName, classification, routing, partialState);
  
  return {
    classification,
    routing,
    shouldRetry,
    reason,
    suggestedAction,
    confidenceAdjusted,
  };
}

/**
 * Check if there's genuinely new evidence that would justify higher confidence
 * 
 * New evidence means information that confirms the intent, not just error messages.
 * Examples:
 * - Partial state that confirms the VM exists (even if wrong state)
 * - Partial results that validate the intent
 * - State information that wasn't available before
 * 
 * NOT new evidence:
 * - Error messages (they don't confirm intent)
 * - Retry attempts (they don't add information)
 * - Parameter listings (they're just what we tried)
 */
function hasGenuineNewEvidence(
  partialState?: Record<string, any>,
  error?: string,
  originalInput?: string,
  enrichedInput?: string
): boolean {
  // If we have partial state that confirms something exists or is in a specific state,
  // that's new evidence
  if (partialState) {
    // Check if partial state contains information that confirms the intent
    const stateKeys = Object.keys(partialState);
    
    // If partial state contains entity information (VM exists, etc.), that's evidence
    if (stateKeys.some(key => 
      key.includes('vm') || 
      key.includes('entity') || 
      key.includes('exists') ||
      key.includes('state') ||
      key.includes('partialData')
    )) {
      // Check if the partial data actually contains useful information
      const hasUsefulData = Object.values(partialState).some(value => {
        if (typeof value === 'object' && value !== null) {
          return Object.keys(value).length > 0;
        }
        return value !== null && value !== undefined && value !== '';
      });
      
      if (hasUsefulData) {
        return true;
      }
    }
  }
  
  // Error messages that suggest partial success or state information
  if (error) {
    const errorLower = error.toLowerCase();
    
    // Errors that contain state information (e.g., "VM exists but is stopped")
    const stateRevealingErrors = [
      'exists but',
      'is already',
      'current state',
      'already in',
      'currently',
      'partial',
    ];
    
    if (stateRevealingErrors.some(pattern => errorLower.includes(pattern))) {
      return true;
    }
  }
  
  // No genuinely new evidence
  return false;
}

/**
 * Determine if we should retry after a failure
 * 
 * Rules:
 * - Don't retry if we've already tried 3+ times
 * - Don't retry if the error suggests a fundamental problem (not transient)
 * - Don't retry if reclassification suggests clarification is needed
 * - Retry if error suggests transient issue and we haven't exceeded max attempts
 */
function shouldRetryAfterFailure(
  attemptNumber: number,
  previousAttemptCount: number,
  error: string,
  classification: IntentClassification,
  routing: RoutingDecision
): boolean {
  const maxAttempts = 3;
  const totalAttempts = attemptNumber + previousAttemptCount;
  
  // Don't retry if we've exceeded max attempts
  if (totalAttempts >= maxAttempts) {
    return false;
  }
  
  // Don't retry if reclassification suggests clarification
  if (routing.route === "clarification") {
    return false;
  }
  
  // Don't retry if error suggests fundamental problem (not transient)
  const fundamentalErrors = [
    "not found",
    "does not exist",
    "invalid",
    "forbidden",
    "unauthorized",
    "permission denied",
    "authentication failed",
    "not supported",
    "not available",
  ];
  
  const errorLower = error.toLowerCase();
  const isFundamental = fundamentalErrors.some(pattern => errorLower.includes(pattern));
  
  if (isFundamental) {
    return false;
  }
  
  // Retry if error suggests transient issue
  const transientErrors = [
    "timeout",
    "connection",
    "network",
    "temporary",
    "rate limit",
    "busy",
    "unavailable",
  ];
  
  const isTransient = transientErrors.some(pattern => errorLower.includes(pattern));
  
  if (isTransient) {
    return true;
  }
  
  // Default: don't retry if we're not sure
  // Better to ask for clarification than retry blindly
  return false;
}

/**
 * Generate a human-readable reason for the failure and reclassification
 */
function generateFailureReason(
  attemptNumber: number,
  error: string,
  toolName: string,
  classification: IntentClassification,
  routing: RoutingDecision
): string {
  const parts: string[] = [];
  
  parts.push(`Attempt ${attemptNumber} failed: ${toolName} returned "${error}"`);
  
  if (routing.route === "clarification") {
    parts.push("Reclassification suggests clarification is needed");
  } else if (routing.route === "llm_reasoning") {
    parts.push("Reclassification suggests trying a different approach");
  } else if (routing.route === "direct_handler") {
    parts.push("Reclassification suggests a direct handler might work");
  }
  
  return parts.join(". ");
}

/**
 * Generate a suggested action based on failure context
 */
function generateSuggestedAction(
  error: string,
  toolName: string,
  classification: IntentClassification,
  routing: RoutingDecision,
  partialState?: Record<string, any>
): string | undefined {
  const errorLower = error.toLowerCase();
  
  // If error suggests VM not found, suggest finding it first
  if (errorLower.includes("not found") || errorLower.includes("does not exist")) {
    if (toolName === "action" || toolName.includes("vm")) {
      return "Try finding the VM by name using twin_query find_vm_by_name first";
    }
  }
  
  // If error suggests permission issue, suggest checking permissions
  if (errorLower.includes("permission") || errorLower.includes("forbidden") || errorLower.includes("unauthorized")) {
    return "Check if the required permissions are available for this operation";
  }
  
  // If error suggests validation issue, suggest validating state first
  if (errorLower.includes("invalid") || errorLower.includes("validation")) {
    return "Validate the current state using twin_query before retrying";
  }
  
  // If partial state suggests something was partially completed, suggest checking state
  if (partialState && Object.keys(partialState).length > 0) {
    return "Check the current state - some operations may have partially completed";
  }
  
  // If routing suggests a different approach, suggest that
  if (routing.route === "llm_reasoning" && routing.reason) {
    return routing.reason;
  }
  
  return undefined;
}

/**
 * Track failure attempts to prevent loops
 */
export class FailureTracker {
  private failures: Map<string, FailureContext[]> = new Map();
  private originalClassifications: Map<string, IntentClassification> = new Map();
  
  /**
   * Store the original classification for an input
   */
  setOriginalClassification(input: string, classification: IntentClassification): void {
    const key = this.getKey(input);
    this.originalClassifications.set(key, classification);
  }
  
  /**
   * Get the original classification for an input
   */
  getOriginalClassification(input: string): IntentClassification | undefined {
    const key = this.getKey(input);
    return this.originalClassifications.get(key);
  }
  
  /**
   * Record a failure for a given input
   */
  recordFailure(input: string, failureContext: FailureContext): void {
    const key = this.getKey(input);
    const failures = this.failures.get(key) || [];
    failures.push(failureContext);
    this.failures.set(key, failures);
  }
  
  /**
   * Get failure history for an input
   */
  getFailureHistory(input: string): FailureContext[] {
    const key = this.getKey(input);
    return this.failures.get(key) || [];
  }
  
  /**
   * Check if we should stop retrying for this input
   */
  shouldStopRetrying(input: string): boolean {
    const history = this.getFailureHistory(input);
    const totalAttempts = history.reduce((sum, f) => sum + f.attemptNumber, 0);
    return totalAttempts >= 3;
  }
  
  /**
   * Clear failure history for an input (after success)
   */
  clearHistory(input: string): void {
    const key = this.getKey(input);
    this.failures.delete(key);
    this.originalClassifications.delete(key);
  }
  
  /**
   * Get a normalized key for tracking
   */
  private getKey(input: string): string {
    return input.trim().toLowerCase();
  }
}
