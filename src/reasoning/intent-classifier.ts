/**
 * Probabilistic Intent Classifier
 * 
 * Uses semantic similarity to classify user intents, treating language variance
 * as a feature rather than an error. No hard-coded patterns or typo detection.
 * 
 * Architecture:
 * 1. Intent Classification: Semantic similarity to intent archetypes
 * 2. Intent Routing: Routes to appropriate handlers
 * 3. Execution: Domain-specific handlers process the intent
 */

export type IntentType = 
  | "QUERY"           // Informational queries (temperature, status, list, describe)
  | "ACTION"          // Mutating operations (create, destroy, install, configure)
  | "CHAT"            // Conversational/ambiguous (needs LLM reasoning)
  | "CLARIFICATION";  // Genuinely ambiguous (needs user input)

export interface IntentClassification {
  type: IntentType;
  confidence: number; // 0-1
  metadata?: {
    domain?: "compute" | "network" | "firewall" | "metrics" | "general";
    actionType?: string;
    queryType?: string;
  };
}

/**
 * Intent archetypes - representative examples for semantic matching
 * These capture the semantic meaning, not exact wording
 */
const INTENT_ARCHETYPES: Record<IntentType, string[]> = {
  QUERY: [
    "what is the temperature",
    "show me the status",
    "list all vms",
    "describe the cluster",
    "what are the nodes",
    "how much memory",
    "which vms are running",
    "tell me about",
    "check the status",
    "get metrics",
    "show firewall rules",
    "what is the uptime",
    "list all containers",
    "show all lxc",
    "name of all lxc",
    "all containers across nodes",
    "list containers",
    "what containers",
    "which containers",
    "need the name",
    "get names",
    "show names",
    "is there a vm",
    "is there a container",
    "does a vm exist",
    "does a container exist",
    "is there a vm called",
    "is there a container called",
    "is there a vm named",
    "is there a container named",
    "does vm exist",
    "does container exist",
    "is vm running",
    "is container running",
    "is there",
    "does exist",
  ],
  ACTION: [
    "create a vm",
    "destroy the vm",
    "install nginx",
    "configure firewall",
    "start the server",
    "stop the container",
    "restart the service",
    "delete the vm",
    "set up docker",
    "allow port 80",
    "assign vlan",
    "put vm in vlan",
  ],
  CHAT: [
    "hello",
    "thanks",
    "help me",
    "can you",
    "is it possible",
    "explain",
    "how does",
    "what if",
  ],
  CLARIFICATION: [
    // This is for genuinely ambiguous cases - usually empty
    // Will be detected by low confidence across all types
  ],
};

/**
 * Simple semantic similarity using word overlap and structure
 * In production, this could use embeddings (OpenAI, local model, etc.)
 */
function semanticSimilarity(query: string, archetype: string): number {
  const queryWords = new Set(query.toLowerCase().split(/\s+/));
  const archetypeWords = new Set(archetype.toLowerCase().split(/\s+/));
  
  // Calculate Jaccard similarity (intersection over union)
  const intersection = new Set([...queryWords].filter(w => archetypeWords.has(w)));
  const union = new Set([...queryWords, ...archetypeWords]);
  
  const jaccard = intersection.size / union.size;
  
  // Boost for structural similarity (word order, key phrases)
  const queryLower = query.toLowerCase();
  const archetypeLower = archetype.toLowerCase();
  
  // Check for key phrase matches
  const keyPhrases = [
    /\b(what|which|where|how|show|list|tell|describe|check|get)\b/,
    /\b(create|destroy|install|configure|start|stop|restart|delete|set|put|assign)\b/,
    /\b(temperature|temp|status|metrics|uptime|memory|cpu|disk)\b/,
    /\b(vm|container|node|firewall|network|service)\b/,
  ];
  
  let structuralBonus = 0;
  for (const phrase of keyPhrases) {
    if (phrase.test(queryLower) && phrase.test(archetypeLower)) {
      structuralBonus += 0.1;
    }
  }
  
  return Math.min(1.0, jaccard + structuralBonus);
}

/**
 * Classify user intent using semantic similarity
 * Returns the most likely intent type with confidence score
 */
export function classifyIntent(userInput: string): IntentClassification {
  const normalized = userInput.trim();
  
  // Strong indicators for QUERY intent (existence queries, information requests)
  // These patterns strongly suggest QUERY, not ACTION
  const queryIndicators = [
    /^is there\b/i,
    /^does .* exist\b/i,
    /^does .* have\b/i,
    /^is .* (called|named)\b/i,
    /^what (is|are|was|were)\b/i,
    /^which .* (is|are|was|were)\b/i,
    /^how (much|many|long)\b/i,
    /^show (me|us)\b/i,
    /^tell (me|us)\b/i,
    /^list\b/i,
    /^describe\b/i,
  ];
  
  // Check for strong query indicators first
  const hasQueryIndicator = queryIndicators.some(pattern => pattern.test(normalized));
  
  // Calculate similarity scores for each intent type
  const scores: Record<IntentType, number> = {
    QUERY: 0,
    ACTION: 0,
    CHAT: 0,
    CLARIFICATION: 0,
  };
  
  // Boost QUERY score if strong query indicators are present
  if (hasQueryIndicator) {
    scores.QUERY = 0.5; // Start with a base score for query indicators
  }
  
  // Score against archetypes
  for (const [intentType, archetypes] of Object.entries(INTENT_ARCHETYPES)) {
    let maxScore = 0;
    for (const archetype of archetypes) {
      const similarity = semanticSimilarity(normalized, archetype);
      maxScore = Math.max(maxScore, similarity);
    }
    scores[intentType as IntentType] = maxScore;
  }
  
  // Find the highest scoring intent
  let bestIntent: IntentType = "CHAT"; // Default fallback
  let bestScore = 0;
  
  for (const [intentType, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestIntent = intentType as IntentType;
    }
  }
  
  // Determine if we need clarification (low confidence across all types)
  const allScores = Object.values(scores);
  const maxScore = Math.max(...allScores);
  const avgScore = allScores.reduce((a, b) => a + b, 0) / allScores.length;
  
  // If max score is low and scores are close together, it's ambiguous
  if (maxScore < 0.3 && (maxScore - avgScore) < 0.1) {
    return {
      type: "CLARIFICATION",
      confidence: maxScore,
    };
  }
  
  // Extract metadata for better routing
  const metadata: IntentClassification["metadata"] = {};
  
  // Detect domain
  const domainKeywords = {
    compute: /\b(vm|container|qemu|lxc|virtual machine|host|node|containers|vms)\b/i,
    network: /\b(network|interface|vlan|subnet|routing|ip|gateway)\b/i,
    firewall: /\b(firewall|rule|allow|block|port|nat)\b/i,
    metrics: /\b(temperature|temp|cpu|memory|ram|disk|status|uptime|metrics|load)\b/i,
  };
  
  for (const [domain, pattern] of Object.entries(domainKeywords)) {
    if (pattern.test(normalized)) {
      metadata.domain = domain as typeof metadata.domain;
      break;
    }
  }
  
  // Detect action type for ACTION intents
  if (bestIntent === "ACTION") {
    const actionPatterns = {
      create: /\b(create|make|spin up|provision|new|add)\b/i,
      destroy: /\b(destroy|delete|remove|kill|terminate)\b/i,
      start: /\b(start|boot|power on|turn on|launch)\b/i,
      stop: /\b(stop|shutdown|power off|turn off|halt)\b/i,
      restart: /\b(restart|reboot|reset|cycle)\b/i,
      install: /\b(install|setup|set up)\b/i,
      configure: /\b(configure|config|set|put|assign)\b/i,
    };
    
    for (const [actionType, pattern] of Object.entries(actionPatterns)) {
      if (pattern.test(normalized)) {
        metadata.actionType = actionType;
        break;
      }
    }
  }
  
  // Detect query type for QUERY intents
  if (bestIntent === "QUERY") {
    const queryPatterns = {
      existence: /\b(is there|does.*exist|does.*have|is.*called|is.*named)\b/i,
      temperature: /\b(temperature|temp)\b/i,
      status: /\b(status|state|health|uptime)\b/i,
      list: /\b(list|show|which|what are)\b/i,
      describe: /\b(describe|tell me about|what is|explain)\b/i,
      metrics: /\b(metrics|usage|load|cpu|memory|ram|disk)\b/i,
    };
    
    for (const [queryType, pattern] of Object.entries(queryPatterns)) {
      if (pattern.test(normalized)) {
        metadata.queryType = queryType;
        break;
      }
    }
  }
  
  return {
    type: bestIntent,
    confidence: bestScore,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

/**
 * Check if an action type is destructive (requires higher confidence threshold)
 */
export function isDestructiveAction(actionType?: string): boolean {
  if (!actionType) return false;
  const destructiveActions = ["destroy", "delete", "remove", "kill", "terminate"];
  return destructiveActions.includes(actionType.toLowerCase());
}

/**
 * Check if intent classification is confident enough to proceed
 * 
 * This is a simple boolean check. For detailed threshold-based routing,
 * use getConfidenceThreshold() in the router instead.
 * 
 * @deprecated Use getConfidenceThreshold() in intent-router for domain-specific thresholds
 */
export function isConfidentClassification(classification: IntentClassification): boolean {
  // QUERY intents are more flexible - allow lower confidence
  if (classification.type === "QUERY") {
    return classification.confidence >= 0.15;
  }
  // ACTION and CHAT need higher confidence
  return classification.confidence >= 0.3 && classification.type !== "CLARIFICATION";
}

