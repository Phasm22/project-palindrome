import { getKnownEntities } from "./clarification";

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
  | "CHAT_SOCIAL"     // Social/short chat (hello, thanks)
  | "CHAT_REASONING"  // Ambiguous problem solving / explanation
  | "CLARIFICATION";  // Genuinely ambiguous (needs user input)

export type RiskLevel = "READ" | "WRITE_LOW" | "WRITE_HIGH" | "DESTRUCTIVE";

export interface IntentEntities {
  hosts: string[];
  services: string[];
  resourceIds: string[];
}

export interface IntentScope {
  env?: string;
  timeRange?: string;
}

export interface IntentOperation {
  type?: string;
  verbs: string[];
}

export interface IntentClassification {
  type: IntentType;
  intent: IntentType;
  confidence: number; // 0-1
  entities: IntentEntities;
  scope: IntentScope;
  operation: IntentOperation;
  risk: RiskLevel;
  missing: string[];
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
  CHAT_SOCIAL: [
    "hello",
    "hi",
    "hey",
    "thanks",
    "thank you",
    "good morning",
    "good evening",
    "bye",
  ],
  CHAT_REASONING: [
    "help me",
    "can you",
    "is it possible",
    "explain",
    "how does",
    "what if",
    "why is",
    "plan",
    "roadmap",
    "i need a subnet for 128 hosts",
    "subnet big enough for 128 hosts",
    "what subnet size do i need",
    "how many hosts in a /24",
    "cidr for 128 hosts",
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
    CHAT_SOCIAL: 0,
    CHAT_REASONING: 0,
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
  let bestIntent: IntentType = "CHAT_REASONING"; // Default fallback
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
    const entities = extractEntities(normalized);
    const scope = extractScope(normalized);
    const operation = extractOperation(normalized);
    return {
      type: "CLARIFICATION",
      intent: "CLARIFICATION",
      confidence: maxScore,
      entities,
      scope,
      operation,
      risk: "READ",
      missing: ["intent"],
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
  
  const entities = extractEntities(normalized);
  const scope = extractScope(normalized);
  const operation = extractOperation(normalized, metadata);
  const risk = determineRisk(bestIntent, metadata?.actionType, operation.verbs);
  const missing = determineMissing(bestIntent, entities, metadata);

  return {
    type: bestIntent,
    intent: bestIntent,
    confidence: bestScore,
    entities,
    scope,
    operation,
    risk,
    missing,
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

function extractEntities(input: string): IntentEntities {
  const entities: IntentEntities = { hosts: [], services: [], resourceIds: [] };
  const lower = input.toLowerCase();

  try {
    const known = getKnownEntities();
    for (const node of known.nodes ?? []) {
      const nodeLower = node.toLowerCase();
      if (nodeLower && new RegExp(`\\b${escapeRegex(nodeLower)}\\b`).test(lower)) {
        entities.hosts.push(node);
      }
    }
    for (const vm of known.vms ?? []) {
      const nameLower = (vm.name || "").toLowerCase();
      if (nameLower && new RegExp(`\\b${escapeRegex(nameLower)}\\b`).test(lower)) {
        entities.resourceIds.push(String(vm.vmid));
        entities.hosts.push(vm.node);
      }
    }
  } catch {
    // Best-effort only; don't fail classification if entity list isn't available.
  }

  const serviceKeywords = [
    "opnsense",
    "proxmox",
    "grafana",
    "prometheus",
    "pihole",
    "ssh",
    "docker",
    "nginx",
  ];
  for (const service of serviceKeywords) {
    if (lower.includes(service)) {
      entities.services.push(service);
    }
  }

  const idMatches = lower.match(/\b(vm|vmid|ct|container)[-\s]?(\d{1,6})\b/g);
  if (idMatches) {
    for (const match of idMatches) {
      const parts = match.split(/[-\s]/);
      const id = parts[parts.length - 1];
      if (id && !entities.resourceIds.includes(id)) {
        entities.resourceIds.push(id);
      }
    }
  }

  entities.hosts = Array.from(new Set(entities.hosts));
  entities.services = Array.from(new Set(entities.services));
  entities.resourceIds = Array.from(new Set(entities.resourceIds));

  return entities;
}

function extractScope(input: string): IntentScope {
  const scope: IntentScope = {};
  const lower = input.toLowerCase();

  if (/\b(prod|production)\b/.test(lower)) scope.env = "prod";
  else if (/\b(staging)\b/.test(lower)) scope.env = "staging";
  else if (/\b(dev|development)\b/.test(lower)) scope.env = "dev";
  else if (/\b(lab)\b/.test(lower)) scope.env = "lab";

  const timeRangeMatch =
    lower.match(/\b(last|past)\s+(\d+)\s*(m|h|d|w|minute|minutes|hour|hours|day|days|week|weeks)\b/) ||
    lower.match(/\b(\d+)\s*(m|h|d|w)\b/);
  if (timeRangeMatch) {
    const num = timeRangeMatch.length >= 4 ? timeRangeMatch[2] : timeRangeMatch[1];
    const unit = timeRangeMatch.length >= 4 ? timeRangeMatch[3] : timeRangeMatch[2];
    if (num && unit) {
      const unitShort = unit.startsWith("m") ? "m" : unit.startsWith("h") ? "h" : unit.startsWith("d") ? "d" : "w";
      scope.timeRange = `${num}${unitShort}`;
    }
  } else if (/\b(today)\b/.test(lower)) {
    scope.timeRange = "today";
  } else if (/\b(yesterday)\b/.test(lower)) {
    scope.timeRange = "yesterday";
  }

  return scope;
}

function extractOperation(input: string, metadata?: IntentClassification["metadata"]): IntentOperation {
  const verbs: string[] = [];
  const lower = input.toLowerCase();
  const verbPatterns: Record<string, RegExp> = {
    create: /\b(create|make|provision|add|spin up)\b/i,
    destroy: /\b(destroy|delete|remove|terminate|kill)\b/i,
    start: /\b(start|boot|power on|turn on|launch)\b/i,
    stop: /\b(stop|shutdown|power off|turn off|halt)\b/i,
    restart: /\b(restart|reboot|reset|cycle)\b/i,
    configure: /\b(configure|config|set|assign|update)\b/i,
    install: /\b(install|setup|set up)\b/i,
    diagnose: /\b(diagnose|troubleshoot|debug|investigate)\b/i,
    explain: /\b(explain|teach|walk me through)\b/i,
  };

  for (const [verb, pattern] of Object.entries(verbPatterns)) {
    if (pattern.test(lower)) {
      verbs.push(verb);
    }
  }

  return {
    type: metadata?.actionType || metadata?.queryType,
    verbs,
  };
}

function determineRisk(intent: IntentType, actionType?: string, verbs: string[] = []): RiskLevel {
  if (intent === "QUERY" || intent === "CHAT_SOCIAL" || intent === "CHAT_REASONING") {
    return "READ";
  }
  if (intent === "CLARIFICATION") {
    return "READ";
  }
  if (intent === "ACTION") {
    if (isDestructiveAction(actionType)) return "DESTRUCTIVE";
    if (["configure", "install", "create"].includes(actionType || "") || verbs.includes("configure") || verbs.includes("install") || verbs.includes("create")) {
      return "WRITE_HIGH";
    }
    if (["start", "stop", "restart"].includes(actionType || "") || verbs.some(v => ["start", "stop", "restart"].includes(v))) {
      return "WRITE_LOW";
    }
    return "WRITE_LOW";
  }
  return "READ";
}

function determineMissing(intent: IntentType, entities: IntentEntities, metadata?: IntentClassification["metadata"]): string[] {
  const missing: string[] = [];

  if (intent === "CLARIFICATION") {
    missing.push("intent");
    return missing;
  }

  if (intent === "ACTION") {
    const hasTarget = entities.hosts.length > 0 || entities.resourceIds.length > 0 || entities.services.length > 0;
    if (!hasTarget) {
      missing.push("target");
    }
    if (!metadata?.actionType) {
      missing.push("operation");
    }
  }

  return missing;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

