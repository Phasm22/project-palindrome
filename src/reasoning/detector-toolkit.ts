/** Shared parsing and hardening primitives for deterministic intent detectors. */

export const KNOWN_NODE_NAMES: ReadonlySet<string> = new Set([
  "yang",
  "yin",
  "proxbig",
  "pve1",
  "pve2",
]);

const MIN_PLAUSIBLE_NAME_LENGTH = 3;

const COMMAND_OPENER_WORDS: ReadonlySet<string> = new Set([
  "please", "can", "could", "would", "will", "you", "i", "we", "want",
  "need", "have", "to", "go", "ahead", "and", "kindly", "just", "now",
  "let's", "let", "us", "should", "gonna",
]);

const ACTION_VERBS: ReadonlySet<string> = new Set([
  "create", "make", "provision", "install", "configure", "set", "assign",
  "destroy", "delete", "remove", "sync", "put", "allow", "open", "start",
  "stop", "restart", "reboot", "shutdown",
]);

const DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
  "destroy",
  "delete",
  "remove",
]);

const ACTION_VERB_LEAD_WORDS = 6;

function stripWordPunctuation(word: string): string {
  return word.replace(/^[.,!?;:'"]+|[.,!?;:'"]+$/g, "");
}

export function isLikelyQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.endsWith("?")) return true;
  return /^(what|which|who|where|when|why|how|is|are|do|does|can|could|would|will)\b/.test(normalized);
}

export function isPlausibleNameCandidate(
  candidate: string | null | undefined
): candidate is string {
  return !!candidate && candidate.trim().length >= MIN_PLAUSIBLE_NAME_LENGTH;
}

function hasLeadingVerbFrom(text: string, verbs: ReadonlySet<string>): boolean {
  const rawWords = text.trim().toLowerCase().split(/\s+/).slice(0, ACTION_VERB_LEAD_WORDS);
  for (const rawWord of rawWords) {
    const word = stripWordPunctuation(rawWord);
    if (verbs.has(word)) return true;
    if (!COMMAND_OPENER_WORDS.has(word)) return false;
  }
  return false;
}

export function hasLeadingDestructiveVerb(text: string): boolean {
  return hasLeadingVerbFrom(text, DESTRUCTIVE_VERBS);
}

/** True for imperative mutations, but false for questions and embedded verb mentions. */
export function isActionRequest(text: string): boolean {
  return !isLikelyQuestion(text) && hasLeadingVerbFrom(text, ACTION_VERBS);
}

export interface VmReference {
  raw: string;
  numericId?: number;
  canonicalId?: string;
}

export interface ExtractVmReferenceOptions {
  allowBareIdAfterDestructiveVerb?: boolean;
  allowDisplayName?: boolean;
  allowQuotedName?: boolean;
  allowVmLabelName?: boolean;
}

/** The sole VM-ID/reference regex implementation used by all detectors. */
export function extractVmReference(
  text: string,
  options: ExtractVmReferenceOptions = {}
): VmReference | null {
  const canonicalMatch = text.match(/compute-vm:[\w-]+:\d+/i);
  if (canonicalMatch?.[0]) {
    const numericPart = canonicalMatch[0].match(/(\d+)$/)?.[1];
    return {
      raw: canonicalMatch[0],
      canonicalId: canonicalMatch[0],
      ...(numericPart ? { numericId: Number(numericPart) } : {}),
    };
  }

  const numericMatch = text.match(
    /(?<![a-z0-9_-])(?:vm(?:\s*-?\s*id)?|vmid|virtual\s+machine)[- ]?(\d+)\b/i
  );
  if (numericMatch?.[1]) {
    return { raw: numericMatch[1], numericId: Number(numericMatch[1]) };
  }

  if (options.allowBareIdAfterDestructiveVerb && hasLeadingDestructiveVerb(text)) {
    const destructiveIdMatch = text.match(
      /\b(?:destroy|delete|remove)\s+(?:(?:the|a|an)\s+)?(?:(?:vm|virtual\s+machine|container|lxc)\s+)?(\d+)\b/i
    );
    if (destructiveIdMatch?.[1]) {
      return { raw: destructiveIdMatch[1], numericId: Number(destructiveIdMatch[1]) };
    }
  }

  if (options.allowDisplayName) {
    const camelCaseVmSuffix = text.match(/\b([A-Za-z][\w-]*[a-z])VM\b/);
    if (camelCaseVmSuffix?.[0]) return { raw: camelCaseVmSuffix[0] };

    const theNameVm = text.match(/\bthe\s+([A-Za-z][\w-]*)\s+VM\b/);
    if (isPlausibleNameCandidate(theNameVm?.[1])) return { raw: theNameVm[1] };
  }

  if (options.allowVmLabelName) {
    const labelMatch = text.match(/\bvm\s+([a-z0-9][a-z0-9._-]*)\b/i);
    if (isPlausibleNameCandidate(labelMatch?.[1])) return { raw: labelMatch[1] };
  }

  if (options.allowQuotedName) {
    const quotedMatch = text.match(/["']([^"']+)["']/);
    if (isPlausibleNameCandidate(quotedMatch?.[1])) return { raw: quotedMatch[1] };
  }

  return null;
}

export interface ExtractNodeNameOptions {
  allowKnownBare?: boolean;
  allowRelations?: boolean;
}

/** The sole node-name resolution implementation used by all detectors. */
export function extractNodeName(
  text: string,
  options: ExtractNodeNameOptions = {}
): string | null {
  const explicitMatch = text.match(/\b(?:node|host)\s+([a-z0-9_-]+)/i);
  if (isPlausibleNameCandidate(explicitMatch?.[1])) return explicitMatch[1];

  if (options.allowRelations !== false) {
    const relationMatch = text.match(/\b(?:on|in|between)\s+(?:node\s+)?([a-z0-9_-]+)/i);
    if (isPlausibleNameCandidate(relationMatch?.[1])) return relationMatch[1];
  }

  if (options.allowKnownBare) {
    const words = new Set(text.toLowerCase().match(/[a-z0-9_-]+/g) ?? []);
    for (const node of KNOWN_NODE_NAMES) {
      if (words.has(node)) return node;
    }
  }
  return null;
}
