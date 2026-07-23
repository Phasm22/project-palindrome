/**
 * Intent Router
 * 
 * Routes classified intents to appropriate execution handlers.
 * Clean separation: classification → routing → execution
 * 
 * This is the routing stage, not dialog-act policy. It consumes classifier
 * output and applies a confidence profile selected by classificationMethod.
 * Jaccard overlap and LLM self-confidence are intentionally not treated as
 * equivalent signals; see ROUTING_THRESHOLD_PROFILES below.
 */

import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import type { HistoricalScore } from "../agent/historical-scorer";
import type { HistoricalScorer } from "../agent/historical-scorer";
import { classifyIntent, isDestructiveAction } from "./intent-classifier";
import type { IntentType, IntentClassification } from "./intent-classifier";
import {
  IntentClassificationSchema,
  CLASSIFICATION_SYSTEM_PROMPT,
  mapLLMResultToIntentClassification,
} from "./intent-schema";
import { detectActionIntent } from "./action-intents";
import { detectComputeIntent } from "./compute-intents";
import { detectFirewallIntent } from "./detectFirewallIntent";
import { detectNetworkIntent } from "./detectNetworkIntent";
import { detectExposureIntent } from "./detectExposureIntent";
import { logger } from "../utils/logger";
import type { Domain } from "./domain-taxonomy";
import { inferDomainFromToolRegistry } from "./classifier-registry";


function getIntentClassifierModelId(): string {
  return process.env.INTENT_CLASSIFIER_MODEL || "gpt-4o-mini";
}

export interface RoutingDecision {
  route: "direct_handler" | "llm_reasoning" | "clarification";
  handler?: string;
  intent?: any; // Domain-specific intent (ActionIntent, ComputeIntent, etc.)
  confidence: number;
  requiresValidation?: boolean; // Set to true if confidence is medium (0.30-0.55)
  reason?: string; // Explanation of routing decision
}

/**
 * The LLM classifier is authoritative when configured. The deterministic
 * Jaccard classifier is a resilience fallback only: it runs when the API key
 * is absent or structured classification throws, never merely because the LLM
 * reports low confidence.
 */
export const CLASSIFIER_FALLBACK_CONTRACT = Object.freeze({
  authoritative: "llm" as const,
  fallback: "jaccard" as const,
  triggers: ["missing_api_key", "classification_error"] as const,
  triggersOnLowConfidence: false,
});

type QueryDomainHandler = {
  handler: string;
  detect: (input: string) => unknown | null;
};

/** Exhaustive direct-handler decision: null means reviewed LLM/tool dispatch. */
export const QUERY_DOMAIN_HANDLERS = {
  compute: { handler: "compute_query", detect: detectComputeIntent },
  network: { handler: "network_query", detect: detectNetworkIntent },
  firewall: { handler: "firewall_query", detect: detectFirewallIntent },
  metrics: null,
  dns: null,
  general: null,
} satisfies Record<Domain, QueryDomainHandler | null>;

const ROUTING_THRESHOLD_PROFILES = {
  // Legacy scores were calibrated around Jaccard overlap and structural boosts.
  jaccard: { metricsQuery: 0.15, query: 0.30, action: 0.50, destructive: 0.70, chat: 0.30 },
  // LLM self-reported confidence is a different signal. Use a separately named,
  // conservative profile until evaluation data supports further calibration.
  llm: { metricsQuery: 0.30, query: 0.50, action: 0.65, destructive: 0.80, chat: 0.50 },
} as const;

/**
 * Confidence threshold levels
 */
export enum ConfidenceLevel {
  TOO_LOW = "too_low",        // < 0.30: Clarification needed
  MEDIUM = "medium",          // 0.30-0.55: Route to LLM with caution
  GOOD = "good",              // 0.55-0.80: Normal flow
  HIGH = "high",              // >= 0.80: Direct handler
}

/**
 * Get confidence threshold for a classification based on domain and action type
 * 
 * Thresholds:
 * - Metrics queries: 0.15 (very permissive, safe to try)
 * - Regular queries: 0.30 (permissive, informational)
 * - Regular actions: 0.50 (moderate, non-destructive)
 * - Destructive actions: 0.70 (strict, irreversible)
 * - CHAT_SOCIAL/CHAT_REASONING: 0.30 (conversational, flexible)
 */
export function getConfidenceThreshold(
  classification: IntentClassification,
  score?: HistoricalScore,
  scorer?: HistoricalScorer,
): number {
  const { type, metadata } = classification;
  const method = classification.classificationMethod ?? "jaccard";
  const profile = ROUTING_THRESHOLD_PROFILES[method];

  // Metrics queries are very safe - tolerate low confidence
  if (type === "QUERY" && (metadata?.domain === "metrics" || metadata?.queryType === "temperature" || metadata?.queryType === "status" || metadata?.queryType === "metrics")) {
    return profile.metricsQuery;
  }

  // Regular queries are safe - moderate threshold
  if (type === "QUERY") {
    const base = profile.query;
    if (score && scorer && scorer.hasEnoughData(score) && score.recencyWeight > 0.7) {
      return Math.max(base - 0.05, method === "llm" ? 0.45 : 0.25);
    }
    return base;
  }

  // Destructive actions need high confidence — never lowered
  if (type === "ACTION" && isDestructiveAction(metadata?.actionType)) {
    return profile.destructive;
  }

  // Regular actions need moderate confidence
  if (type === "ACTION") {
    const base = profile.action;
    if (score && scorer && scorer.hasEnoughData(score) && score.recencyWeight > 0.7) {
      return Math.max(base - 0.05, method === "llm" ? 0.60 : 0.25);
    }
    return base;
  }

  // CHAT is flexible
  if (type === "CHAT_SOCIAL" || type === "CHAT_REASONING") {
    return profile.chat;
  }

  // CLARIFICATION always needs clarification
  if (type === "CLARIFICATION") {
    return 1.0; // Never confident
  }

  // Default: moderate threshold
  return 0.50;
}

/**
 * Get confidence level for routing decisions
 */
export function getConfidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence < 0.30) return ConfidenceLevel.TOO_LOW;
  if (confidence < 0.55) return ConfidenceLevel.MEDIUM;
  if (confidence < 0.80) return ConfidenceLevel.GOOD;
  return ConfidenceLevel.HIGH;
}

/**
 * Check if classification meets the required threshold for its domain/action type
 */
export function meetsConfidenceThreshold(
  classification: IntentClassification,
  score?: HistoricalScore,
  scorer?: HistoricalScorer,
): boolean {
  const threshold = getConfidenceThreshold(classification, score, scorer);
  return classification.confidence >= threshold;
}

/**
 * Route classified intent to appropriate handler
 * 
 * Uses confidence thresholds to make routing decisions:
 * - < 0.30: Clarification needed
 * - 0.30-0.55: Route to LLM with validation flag
 * - 0.55-0.80: Normal routing (direct handler or LLM based on complexity)
 * - >= 0.80: Route to direct handler (high confidence)
 */
export function routeIntent(
  userInput: string,
  classification: IntentClassification
): RoutingDecision {
  const confidence = classification.confidence;
  const level = getConfidenceLevel(confidence);
  const threshold = getConfidenceThreshold(classification);
  
  // Check if confidence meets threshold
  if (!meetsConfidenceThreshold(classification)) {
    const reason = classification.type === "ACTION" && isDestructiveAction(classification.metadata?.actionType)
      ? `Destructive action requires confidence >= ${threshold}, got ${confidence.toFixed(2)}`
      : `${classification.type} requires confidence >= ${threshold}, got ${confidence.toFixed(2)}`;
    
    return {
      route: "clarification",
      confidence,
      reason,
    };
  }
  
  // Route based on confidence level and intent type
  switch (level) {
    case ConfidenceLevel.TOO_LOW:
      // Shouldn't reach here if threshold check passed, but handle it
      return {
        route: "clarification",
        confidence,
        reason: `Confidence ${confidence.toFixed(2)} is too low (threshold: ${threshold})`,
      };
    
    case ConfidenceLevel.MEDIUM:
      // Medium confidence: route to LLM with validation flag
      return routeWithValidation(userInput, classification, true);
    
    case ConfidenceLevel.GOOD:
    case ConfidenceLevel.HIGH:
      // Good/high confidence: normal routing
      return routeWithValidation(userInput, classification, false);
    
    default:
      return {
        route: "llm_reasoning",
        confidence,
        reason: "Unknown confidence level",
      };
  }
}

/**
 * Route intent with optional validation flag
 */
function routeWithValidation(
  userInput: string,
  classification: IntentClassification,
  requiresValidation: boolean
): RoutingDecision {
  switch (classification.type) {
    case "ACTION":
      return routeActionIntent(userInput, classification, requiresValidation);
    
    case "QUERY":
      return routeQueryIntent(userInput, classification, requiresValidation);
    
    case "CHAT_SOCIAL":
    case "CHAT_REASONING":
      return {
        route: "llm_reasoning",
        confidence: classification.confidence,
        requiresValidation,
        reason: "Conversational query",
      };
    
    case "CLARIFICATION":
      return {
        route: "clarification",
        confidence: classification.confidence,
        reason: "Classification marked as clarification",
      };
    
    default:
      return {
        route: "llm_reasoning",
        confidence: classification.confidence,
        requiresValidation,
        reason: "Unknown intent type",
      };
  }
}

/**
 * Route action intents to specific action handlers
 */
function routeActionIntent(
  userInput: string,
  classification: IntentClassification,
  requiresValidation: boolean
): RoutingDecision {
  const isDestructive = isDestructiveAction(classification.metadata?.actionType);
  const confidence = classification.confidence;
  
  // Try to detect specific action intent
  const actionIntent = detectActionIntent(userInput);
  
  if (actionIntent) {
    // For destructive actions with high confidence, route directly
    // For medium confidence or non-destructive, route to LLM for safety
    if (isDestructive && confidence >= 0.80) {
      return {
        route: "direct_handler",
        handler: "action_executor",
        intent: actionIntent,
        confidence,
        requiresValidation: false,
        reason: `High confidence (${confidence.toFixed(2)}) destructive action`,
      };
    }
    
    // Medium confidence destructive actions go to LLM with validation
    if (isDestructive) {
      return {
        route: "llm_reasoning",
        confidence,
        requiresValidation: true,
        reason: `Destructive action requires validation (confidence: ${confidence.toFixed(2)})`,
      };
    }
    
    // Non-destructive actions: route based on confidence
    if (confidence >= 0.80) {
      return {
        route: "direct_handler",
        handler: "action_executor",
        intent: actionIntent,
        confidence,
        requiresValidation,
        reason: `High confidence (${confidence.toFixed(2)}) action`,
      };
    }
    
    // Medium confidence: route to LLM
    return {
      route: "llm_reasoning",
      confidence,
      requiresValidation,
      reason: `Medium confidence (${confidence.toFixed(2)}) action`,
    };
  }
  
  // If we classified as ACTION but couldn't parse specific intent,
  // let LLM handle it (might be complex compound action)
  return {
    route: "llm_reasoning",
    confidence: confidence * 0.8, // Lower confidence since we couldn't parse
    requiresValidation,
    reason: "Could not parse specific action intent",
  };
}

/**
 * Route query intents to specific query handlers
 * 
 * Metrics queries tolerate lower confidence and can route directly.
 * Other queries need higher confidence for direct handlers.
 */
function routeQueryIntent(
  userInput: string,
  classification: IntentClassification,
  requiresValidation: boolean
): RoutingDecision {
  const domain = classification.metadata?.domain;
  const queryType = classification.metadata?.queryType;
  const confidence = classification.confidence;
  
  // Metrics queries are safe - route to LLM with twin_query tool
  // They tolerate lower confidence (threshold: 0.15)
  if (domain === "metrics" || queryType === "temperature" || queryType === "status" || queryType === "metrics") {
    return {
      route: "llm_reasoning",
      confidence,
      requiresValidation: false, // Metrics queries are safe, no validation needed
      reason: "Metrics query (low threshold, safe)",
    };
  }
  
  // Try the domain's explicitly registered direct detector for high-confidence queries.
  if (confidence >= 0.80) {
    const directRegistration = domain ? QUERY_DOMAIN_HANDLERS[domain] : null;
    const directIntent = directRegistration?.detect(userInput) ?? null;
    if (directRegistration && directIntent) {
      return {
        route: "direct_handler",
        handler: directRegistration.handler,
        intent: directIntent,
        confidence,
        requiresValidation: false,
        reason: `High confidence (${confidence.toFixed(2)}) ${domain} query`,
      };
    }
    
    // Check for exposure intent (cross-domain)
    const exposureIntent = detectExposureIntent(userInput);
    if (exposureIntent) {
      return {
        route: "direct_handler",
        handler: "exposure_query",
        intent: exposureIntent,
        confidence,
        requiresValidation: false,
        reason: `High confidence (${confidence.toFixed(2)}) exposure query`,
      };
    }
  }
  
  // Fallback: route to LLM with appropriate tools
  return {
    route: "llm_reasoning",
    confidence,
    requiresValidation,
    reason: `Query routed to LLM (confidence: ${confidence.toFixed(2)})`,
  };
}

/**
 * Detect clear informational questions that should not trigger disambiguation.
 * When the user is obviously asking to observe/explain (not act), route to QUERY
 * instead of asking "observe, diagnose, change, or explain?".
 */
function isClearInformationalQuery(userInput: string): boolean {
  const n = userInput.trim().toLowerCase();
  if (n.length < 4) return false;
  const patterns = [
    /\b(want to see|want to know|want to check|want to find out)\b/,
    /\bwhat (ip|network|address)\b/,
    /\bwhich (ip|network)\b/,
    /\bare there (any)?\s+/,
    /\b(is|are) there (any)?\s+/,
    /\b(show|tell|list|describe|give|gimme)\s+(me\s+)?(the\s+)?/,
    /\b(what|how)\s+(is|are|does|do)\s+/,
    /\b(which|what)\s+(vm|container|node|firewall|rule|network)\s+/,
    // Imperative read-only diagnostic commands ("ping X", "traceroute to X") — clearly
    // a request to observe/check, not an ambiguous "observe/diagnose/change?" case.
    /^(ping|traceroute|trace route)\b/,
    /\b(check|run)\b.*\b(diagnostic|health|connectivity|disk|status)\b/,
    /\bdiagnose\b/,
    /\bsummar(y|ize)\b/,
    // Loose "<entity noun> ... on <target>" phrasing tolerant of filler/punctuation
    // (e.g. "vms???? on yang???? pls?????").
    /\b(vms?|nodes?|containers?|interfaces?|rules?)\b.{0,20}\bon\b/,
  ];
  return patterns.some((p) => p.test(n));
}

function applyInformationalBypass(
  userInput: string,
  initialClassification: IntentClassification
): { classification: IntentClassification; routing: RoutingDecision } {
  let classification = initialClassification;
  let routing = routeIntent(userInput, classification);

  if (routing.route !== "clarification" || !isClearInformationalQuery(userInput)) {
    return { classification, routing };
  }

  const metadata = { ...classification.metadata };
  if (!metadata.domain || metadata.domain === "general") {
    metadata.domain = inferDomainFromToolRegistry(userInput);
  }
  classification = {
    ...classification,
    type: "QUERY",
    intent: "QUERY",
    confidence: 0.5,
    missing: [],
    metadata,
  };
  routing = routeIntent(userInput, classification);
  return { classification, routing };
}

/**
 * Main entry point: classify and route user input
 */
export function classifyAndRoute(userInput: string): {
  classification: IntentClassification;
  routing: RoutingDecision;
} {
  return applyInformationalBypass(userInput, classifyIntent(userInput));
}

/**
 * Classify user intent using LLM (generateObject). Falls back to sync classifyIntent on API/parse failure.
 */
export async function classifyIntentWithLLM(userInput: string): Promise<IntentClassification> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey?.trim()) {
    return classifyIntent(userInput);
  }
  try {
    const { object } = await generateObject({
      // Provider may expose LanguageModelV3; ai@5 types expect LanguageModelV2 — cast for compatibility
      model: openai(getIntentClassifierModelId()) as unknown as Parameters<typeof generateObject>[0]["model"],
      schema: IntentClassificationSchema,
      system: CLASSIFICATION_SYSTEM_PROMPT,
      prompt: `Classify this homelab request: "${userInput.replace(/"/g, '\\"')}"`,
    });
    return mapLLMResultToIntentClassification(object);
  } catch (err) {
    logger.warn("LLM intent classification failed, falling back to regex classifier", {
      error: err instanceof Error ? err.message : String(err),
    });
    return classifyIntent(userInput);
  }
}

/**
 * Classify and route using LLM (generateObject); falls back to sync classifyAndRoute on API failure.
 * Applies same bypass-clarification logic for clear informational queries as classifyAndRoute.
 */
export async function classifyAndRouteWithLLM(userInput: string): Promise<{
  classification: IntentClassification;
  routing: RoutingDecision;
}> {
  return applyInformationalBypass(userInput, await classifyIntentWithLLM(userInput));
}
