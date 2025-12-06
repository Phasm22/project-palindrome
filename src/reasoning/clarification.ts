/**
 * Rule-Based Clarification System
 * 
 * Detects typos, ambiguous queries, and unknown entities.
 * Returns clarification suggestions when confidence is low.
 * 
 * No LLM needed - uses fuzzy matching and entity recognition.
 */

/**
 * Levenshtein distance for typo detection
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Known infrastructure terms and their typo variants
 */
const INFRA_TERMS: Record<string, { canonical: string; description: string; aliases: string[] }> = {
  vm: {
    canonical: "VM",
    description: "Virtual Machine (QEMU)",
    aliases: ["virtual machine", "qemu", "vms"],
  },
  container: {
    canonical: "container",
    description: "LXC Container",
    aliases: ["lxc", "ct", "containers"],
  },
  node: {
    canonical: "node",
    description: "Proxmox Node",
    aliases: ["host", "server", "pve"],
  },
  snapshot: {
    canonical: "snapshot",
    description: "VM/Container Snapshot",
    aliases: ["snap", "backup"],
  },
  vlan: {
    canonical: "VLAN",
    description: "Virtual LAN",
    aliases: ["vlan", "network", "subnet"],
  },
  firewall: {
    canonical: "firewall",
    description: "Firewall Rules",
    aliases: ["fw", "rules", "pf"],
  },
};

/**
 * Known Proxmox nodes (will be populated from ingested data)
 */
let knownNodes: string[] = ["proxBig", "YANG", "YIN"];

/**
 * Known VMs/Containers (will be populated from ingested data)
 */
let knownVMs: Array<{ name: string; vmid: number; node: string; type: "qemu" | "lxc" }> = [];

/**
 * Action verbs and their meanings
 */
const ACTION_VERBS: Record<string, { canonical: string; aliases: string[] }> = {
  create: { canonical: "create", aliases: ["make", "spin up", "provision", "new", "add"] },
  destroy: { canonical: "destroy", aliases: ["delete", "remove", "kill", "terminate", "rm"] },
  start: { canonical: "start", aliases: ["boot", "power on", "turn on", "launch"] },
  stop: { canonical: "stop", aliases: ["shutdown", "power off", "turn off", "halt"] },
  restart: { canonical: "restart", aliases: ["reboot", "reset", "cycle"] },
  list: { canonical: "list", aliases: ["show", "get", "what", "which", "display"] },
  status: { canonical: "status", aliases: ["state", "health", "check"] },
};

/**
 * Common keyboard typos (adjacent keys)
 */
const KEYBOARD_ADJACENT: Record<string, string[]> = {
  q: ["w", "a"],
  w: ["q", "e", "s"],
  e: ["w", "r", "d"],
  r: ["e", "t", "f"],
  t: ["r", "y", "g"],
  y: ["t", "u", "h"],
  u: ["y", "i", "j"],
  i: ["u", "o", "k"],
  o: ["i", "p", "l"],
  p: ["o", "[", ";"],
  a: ["q", "s", "z"],
  s: ["a", "w", "d", "x"],
  d: ["s", "e", "f", "c"],
  f: ["d", "r", "g", "v"],
  g: ["f", "t", "h", "b"],
  h: ["g", "y", "j", "n"],
  j: ["h", "u", "k", "m"],
  k: ["j", "i", "l"],
  l: ["k", "o", ";"],
  z: ["a", "x"],
  x: ["z", "s", "c"],
  c: ["x", "d", "v"],
  v: ["c", "f", "b"],
  b: ["v", "g", "n"],
  n: ["b", "h", "m"],
  m: ["n", "j"],
};

/**
 * Check if two strings differ by only adjacent key typos
 */
function isAdjacentKeyTypo(typed: string, intended: string): boolean {
  if (typed.length !== intended.length) return false;
  
  let typoCount = 0;
  for (let i = 0; i < typed.length; i++) {
    if (typed[i] !== intended[i]) {
      const adjacent = KEYBOARD_ADJACENT[intended[i].toLowerCase()] || [];
      if (adjacent.includes(typed[i].toLowerCase())) {
        typoCount++;
      } else {
        return false;
      }
    }
  }
  
  return typoCount === 1; // Exactly one adjacent key typo
}

/**
 * Find closest matching term
 */
function findClosestTerm(input: string, terms: string[]): { term: string; distance: number; isTypo: boolean } | null {
  const normalized = input.toLowerCase();
  let bestMatch: { term: string; distance: number; isTypo: boolean } | null = null;
  
  for (const term of terms) {
    const termLower = term.toLowerCase();
    
    // Exact match
    if (normalized === termLower) {
      return { term, distance: 0, isTypo: false };
    }
    
    // Skip if lengths are too different (prevents "cm" matching "destroy")
    const lengthDiff = Math.abs(normalized.length - termLower.length);
    if (lengthDiff > 2) {
      continue;
    }
    
    // Check adjacent key typo first (more reliable)
    if (isAdjacentKeyTypo(normalized, termLower)) {
      return { term, distance: 1, isTypo: true };
    }
    
    // Levenshtein distance
    const distance = levenshteinDistance(normalized, termLower);
    
    // Only consider close matches (max 1 edit for short words, 2 for longer)
    // Also require that distance is less than half the word length
    const maxDistance = termLower.length <= 4 ? 1 : 2;
    const maxAllowedByLength = Math.floor(Math.min(normalized.length, termLower.length) / 2);
    
    if (distance <= Math.min(maxDistance, maxAllowedByLength) && (!bestMatch || distance < bestMatch.distance)) {
      bestMatch = { term, distance, isTypo: distance > 0 };
    }
  }
  
  return bestMatch;
}

/**
 * Clarification result
 */
export interface ClarificationResult {
  needsClarification: boolean;
  confidence: number; // 0-1
  originalInput: string;
  interpretation?: string;
  suggestions?: ClarificationSuggestion[];
  corrections?: TypoCorrection[];
  unknownEntities?: string[];
}

export interface ClarificationSuggestion {
  id: number;
  text: string;
  action?: string;
  target?: string;
  node?: string;
}

export interface TypoCorrection {
  original: string;
  corrected: string;
  type: "adjacent_key" | "levenshtein";
}

/**
 * Parse input and detect potential issues
 */
export function analyzeInput(input: string): ClarificationResult {
  const words = input.toLowerCase().split(/\s+/);
  const corrections: TypoCorrection[] = [];
  const suggestions: ClarificationSuggestion[] = [];
  const unknownEntities: string[] = [];
  let confidence = 1.0;
  
  // Extract potential action verb
  let detectedAction: string | null = null;
  let detectedTarget: string | null = null;
  let detectedNode: string | null = null;
  
  for (const word of words) {
    // Skip very short words for action verb matching (they cause false positives like "cm" -> "destroy")
    const skipTypoMatch = word.length < 3;
    
    // Check for action verbs
    for (const [action, info] of Object.entries(ACTION_VERBS)) {
      if (word === action || info.aliases.includes(word)) {
        detectedAction = info.canonical;
        break;
      }
      // Check for typos in action verbs (but not for very short words)
      if (!skipTypoMatch) {
        const match = findClosestTerm(word, [action, ...info.aliases]);
        if (match && match.isTypo) {
          corrections.push({
            original: word,
            corrected: action,
            type: match.distance === 1 && isAdjacentKeyTypo(word, action) ? "adjacent_key" : "levenshtein",
          });
          detectedAction = info.canonical;
          confidence -= 0.2;
          break;
        }
      }
    }
    
    // Check for infrastructure terms
    for (const [term, info] of Object.entries(INFRA_TERMS)) {
      if (word === term || info.aliases.includes(word)) {
        detectedTarget = info.canonical;
        break;
      }
      // Check for typos
      const match = findClosestTerm(word, [term, ...info.aliases]);
      if (match && match.isTypo) {
        corrections.push({
          original: word,
          corrected: term,
          type: match.distance === 1 && isAdjacentKeyTypo(word, term) ? "adjacent_key" : "levenshtein",
        });
        detectedTarget = info.canonical;
        confidence -= 0.2;
        break;
      }
    }
    
    // Check for known nodes
    const nodeMatch = findClosestTerm(word, knownNodes);
    if (nodeMatch) {
      if (nodeMatch.isTypo) {
        corrections.push({
          original: word,
          corrected: nodeMatch.term,
          type: nodeMatch.distance === 1 ? "adjacent_key" : "levenshtein",
        });
        confidence -= 0.1;
      }
      detectedNode = nodeMatch.term;
    }
    
    // Check for known VM names
    const vmNames = knownVMs.map(v => v.name);
    const vmMatch = findClosestTerm(word, vmNames);
    if (vmMatch && !detectedTarget) {
      if (vmMatch.isTypo) {
        corrections.push({
          original: word,
          corrected: vmMatch.term,
          type: vmMatch.distance === 1 ? "adjacent_key" : "levenshtein",
        });
        confidence -= 0.1;
      }
      detectedTarget = vmMatch.term;
    }
  }
  
  // Special case: "cm" is likely "vm" (c is next to v)
  // This should override any other corrections for "cm"
  if (words.includes("cm")) {
    // Remove any other corrections for "cm" (like "destroy")
    const cmIndex = corrections.findIndex(c => c.original === "cm");
    if (cmIndex !== -1) {
      corrections.splice(cmIndex, 1);
    }
    corrections.push({
      original: "cm",
      corrected: "vm",
      type: "adjacent_key",
    });
    detectedTarget = "VM";
    confidence -= 0.3;
  }
  
  // Deduplicate corrections - keep only one per original word
  // Priority: adjacent_key > levenshtein (adjacent key typos are more reliable)
  const deduplicatedCorrections: TypoCorrection[] = [];
  const seenOriginals = new Map<string, TypoCorrection>();
  
  for (const correction of corrections) {
    const existing = seenOriginals.get(correction.original);
    if (!existing) {
      seenOriginals.set(correction.original, correction);
      deduplicatedCorrections.push(correction);
    } else if (correction.type === "adjacent_key" && existing.type === "levenshtein") {
      // Replace levenshtein with adjacent_key (more reliable)
      const idx = deduplicatedCorrections.indexOf(existing);
      if (idx !== -1) {
        deduplicatedCorrections[idx] = correction;
        seenOriginals.set(correction.original, correction);
      }
    }
  }
  
  // Build suggestions if confidence is low
  if (confidence < 0.8 || deduplicatedCorrections.length > 0) {
    let suggestionId = 1;
    
    // If we detected a likely typo, suggest the correction
    if (deduplicatedCorrections.length > 0) {
      const correctedInput = deduplicatedCorrections.reduce(
        (text, c) => text.replace(new RegExp(`\\b${c.original}\\b`, "gi"), c.corrected),
        input
      );
      
      suggestions.push({
        id: suggestionId++,
        text: correctedInput,
        action: detectedAction || undefined,
        target: detectedTarget || undefined,
        node: detectedNode || undefined,
      });
    }
    
    // If we have action + node but unclear target, suggest common targets
    if (detectedAction && detectedNode && !detectedTarget) {
      suggestions.push({
        id: suggestionId++,
        text: `${detectedAction} a VM on ${detectedNode}`,
        action: detectedAction,
        target: "VM",
        node: detectedNode,
      });
      suggestions.push({
        id: suggestionId++,
        text: `${detectedAction} a container on ${detectedNode}`,
        action: detectedAction,
        target: "container",
        node: detectedNode,
      });
    }
  }
  
  // Determine if clarification is needed
  const needsClarification = confidence < 0.7 || 
    (deduplicatedCorrections.length > 0 && suggestions.length > 0) ||
    unknownEntities.length > 0;
  
  // Build interpretation string
  let interpretation: string | undefined;
  if (detectedAction || detectedTarget || detectedNode) {
    const parts = [];
    if (detectedAction) parts.push(`action: ${detectedAction}`);
    if (detectedTarget) parts.push(`target: ${detectedTarget}`);
    if (detectedNode) parts.push(`node: ${detectedNode}`);
    interpretation = parts.join(", ");
  }
  
  return {
    needsClarification,
    confidence,
    originalInput: input,
    interpretation,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
    corrections: deduplicatedCorrections.length > 0 ? deduplicatedCorrections : undefined,
    unknownEntities: unknownEntities.length > 0 ? unknownEntities : undefined,
  };
}

/**
 * Format clarification message for user
 */
export function formatClarificationMessage(result: ClarificationResult): string {
  const lines: string[] = [];
  
  if (result.corrections && result.corrections.length > 0) {
    const typoList = result.corrections
      .map(c => `"${c.original}" → "${c.corrected}"`)
      .join(", ");
    lines.push(`🔍 I noticed some possible typos: ${typoList}`);
  }
  
  if (result.suggestions && result.suggestions.length > 0) {
    lines.push("");
    lines.push("Did you mean one of these?");
    for (const suggestion of result.suggestions) {
      lines.push(`  ${suggestion.id}. ${suggestion.text}`);
    }
    lines.push("");
    lines.push("Reply with a number (1, 2, etc.) or rephrase your request.");
  }
  
  if (result.unknownEntities && result.unknownEntities.length > 0) {
    lines.push("");
    lines.push(`❓ I don't recognize: ${result.unknownEntities.join(", ")}`);
    lines.push("Could you clarify what you mean?");
  }
  
  return lines.join("\n");
}

/**
 * Update known entities from ingested data
 */
export function updateKnownEntities(entities: {
  nodes?: string[];
  vms?: Array<{ name: string; vmid: number; node: string; type: "qemu" | "lxc" }>;
}): void {
  if (entities.nodes) {
    knownNodes = [...new Set([...knownNodes, ...entities.nodes])];
  }
  if (entities.vms) {
    // Merge, avoiding duplicates by vmid
    const existingIds = new Set(knownVMs.map(v => v.vmid));
    for (const vm of entities.vms) {
      if (!existingIds.has(vm.vmid)) {
        knownVMs.push(vm);
        existingIds.add(vm.vmid);
      }
    }
  }
}

/**
 * Get current known entities (for debugging)
 */
export function getKnownEntities(): { nodes: string[]; vms: typeof knownVMs } {
  return { nodes: knownNodes, vms: knownVMs };
}

/**
 * Flag to track if entities have been loaded
 */
let entitiesLoaded = false;

/**
 * Load known entities from Proxmox via the readonly tool
 * This is called lazily on first agent run
 */
export async function loadKnownEntitiesFromProxmox(
  executeToolFn: (toolName: string, params: Record<string, any>) => Promise<any>
): Promise<void> {
  if (entitiesLoaded) return;
  
  try {
    // Get nodes from list_nodes
    const nodesResult = await executeToolFn("proxmox_readonly", { action: "list_nodes" });
    if (nodesResult?.data?.nodes) {
      const nodes = nodesResult.data.nodes.map((n: any) => n.node || n.name).filter(Boolean);
      if (nodes.length > 0) {
        knownNodes = [...new Set([...knownNodes, ...nodes])];
      }
    }
    
    // Get VMs from cluster_resources
    const resourcesResult = await executeToolFn("proxmox_readonly", { action: "cluster_resources" });
    if (resourcesResult?.data?.resources) {
      const vms = resourcesResult.data.resources
        .filter((r: any) => r.type === "qemu" || r.type === "lxc")
        .map((r: any) => ({
          name: r.name || "",
          vmid: r.vmid,
          node: r.node,
          type: r.type as "qemu" | "lxc",
        }));
      
      updateKnownEntities({ vms });
    }
    
    entitiesLoaded = true;
    console.log(`[clarification] Loaded ${knownNodes.length} nodes, ${knownVMs.length} VMs`);
  } catch (error: any) {
    console.warn(`[clarification] Failed to load entities from Proxmox: ${error.message}`);
    // Continue with default entities
  }
}

/**
 * Check if input is a clarification response (e.g., "1", "2", "yes")
 */
export function isClarificationResponse(input: string): { isResponse: boolean; selectedOption?: number } {
  const trimmed = input.trim().toLowerCase();
  
  // Check for number selection
  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num > 0 && num <= 10) {
    return { isResponse: true, selectedOption: num };
  }
  
  // Check for yes/no
  if (["yes", "y", "yeah", "yep", "correct", "right"].includes(trimmed)) {
    return { isResponse: true, selectedOption: 1 }; // Default to first option
  }
  
  if (["no", "n", "nope", "neither", "none"].includes(trimmed)) {
    return { isResponse: true, selectedOption: 0 }; // 0 means "none of the above"
  }
  
  return { isResponse: false };
}

