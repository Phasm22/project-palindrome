export type FirewallIntent =
  | { type: "list_rules" }
  | { type: "count_rules"; direction?: "in" | "out" }
  | { type: "alias_contents"; aliasName: string }
  | { type: "alias_list" }
  | { type: "allowed_ports_between"; from: string; to: string }
  | { type: "rules_by_chain"; chain: string }
  | { type: "sources_accessing_network"; chain: string; target: string }
  | { type: "rules_allowing_subnet"; subnet: string }
  | { type: "rules_blocking_subnet"; subnet: string }
  | { type: "rules_by_port"; port: string }
  | { type: "exposure_map"; vmId?: string }
  | { type: "reachability_from_chain"; chain: string }
  | { type: "rule_impact"; ruleId: string };

const CIDR_REGEX = /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/;
const RULE_ID_REGEX = /\bfw-rule:[a-z0-9:._-]+/i;
const WIREGUARD_PATTERN = /\b(?:wireguard|wg)\b/i;
const PORT_NUMBER_REGEX = /\bport\s+(\d{1,5})\b/i;

function extractSubnet(text: string): string | null {
  const match = text.match(CIDR_REGEX);
  return match ? match[0] : null;
}

function extractVmId(text: string): string | null {
  const reference = extractVmReference(text, { allowDisplayName: true });
  if (!reference) return null;
  if (reference.canonicalId) return reference.canonicalId;
  if (reference.numericId) return `compute-vm:proxbig:${reference.numericId}`;
  return reference.raw;
}

function extractRuleId(text: string): string | null {
  const match = text.match(RULE_ID_REGEX);
  return match ? match[0] : null;
}

function extractAllowedPortsScope(text: string): { from: string; to: string } | null {
  // Standard: "ports allowed from X to Y"
  const match =
    text.match(/\bports?\b.*\bfrom\s+(.+?)\s+to\s+(.+?)(?:\?|$)/i) ??
    text.match(/\ballowed\b.*\bfrom\s+(.+?)\s+to\s+(.+?)(?:\?|$)/i);
  if (match?.[1] && match?.[2]) {
    return { from: match[1].trim(), to: match[2].trim() };
  }

  // Natural language: "come into DEST from SRC" / "reach DEST from SRC"
  const intoFromMatch = text.match(/\b(?:into|reach|access)\s+(?:the\s+)?(.+?)\s+from\s+(?:the\s+)?(.+?)(?:\?|$)/i);
  if (intoFromMatch?.[1] && intoFromMatch?.[2]) {
    return { from: intoFromMatch[2].trim(), to: intoFromMatch[1].trim() };
  }

  // Natural language: "from SRC to/into DEST"
  const fromToMatch = text.match(/\bfrom\s+(?:the\s+)?(.+?)\s+(?:to|into)\s+(?:the\s+)?(.+?)(?:\?|$)/i);
  if (fromToMatch?.[1] && fromToMatch?.[2]) {
    return { from: fromToMatch[1].trim(), to: fromToMatch[2].trim() };
  }

  return null;
}

// Words that can never be part of an alias name — used to stop a greedy capture
// from running on into the rest of the sentence (e.g. "the WG_VIP alias were
// removed, and are any of them internet-exposed?" previously captured the alias
// name as "were removed, and are any of them internet-exposed").
const ALIAS_NAME_STOPWORDS = new Set([
  "the", "a", "an", "this", "that", "which", "who", "were", "was", "is", "are",
  "has", "have", "had", "would", "could", "should", "will", "and", "or", "but",
  "if", "when", "then", "removed", "deleted", "gone", "named", "called",
  "contents", "members", "entries", "for", "of", "in",
]);

function cleanAliasName(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.?!]+$/g, "")
    .trim();
  return cleaned || null;
}

/** Truncates a greedily-captured candidate at the first stopword so trailing
 * sentence text (e.g. "were removed, and are any of them...") never leaks in. */
function truncateAliasCandidate(candidate: string): string | null {
  const words = candidate.trim().split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const word of words) {
    const bare = word.replace(/[.,;:!?"'`]+$/g, "");
    if (ALIAS_NAME_STOPWORDS.has(bare.toLowerCase())) break;
    kept.push(word);
  }
  return kept.length > 0 ? kept.join(" ") : null;
}

function extractAliasName(text: string): string | null {
  // "the WG_VIP alias", "WG_VIP alias were removed" — name precedes the word
  // "alias", which is the more natural English ordering and was previously
  // unhandled outside of quoted names.
  const precedingTokenMatch = text.match(/\b([A-Za-z][A-Za-z0-9_.-]{1,40})\s+alias\b/i);
  if (precedingTokenMatch?.[1] && !ALIAS_NAME_STOPWORDS.has(precedingTokenMatch[1].toLowerCase())) {
    const cleaned = cleanAliasName(precedingTokenMatch[1]);
    if (cleaned) return cleaned;
  }

  const aliasAfterMatch = text.match(/\balias\s+["'`]?(.+?)(?:["'`]?\s*(?:contents?|members?|entries?)\b|[.?!]|$)/i);
  if (aliasAfterMatch?.[1]) {
    const truncated = truncateAliasCandidate(aliasAfterMatch[1]);
    if (truncated) return cleanAliasName(truncated);
  }

  const aliasBeforeMatch = text.match(/\b(?:contents?|members?|entries?)\s+(?:of|in|for)\s+(?:the\s+)?alias\s+["'`]?(.+?)(?:["'`]?[.?!]|$)/i);
  if (aliasBeforeMatch?.[1]) {
    const truncated = truncateAliasCandidate(aliasBeforeMatch[1]);
    if (truncated) return cleanAliasName(truncated);
  }

  const quotedAliasMatch = text.match(/["'`]([^"'`]+)["'`]\s+alias\b/i);
  if (quotedAliasMatch?.[1]) {
    return cleanAliasName(quotedAliasMatch[1]);
  }

  return null;
}

function extractChain(text: string): string | null {
  if (WIREGUARD_PATTERN.test(text)) {
    return "chain:wireguard";
  }

  const match = text.match(/\b(?:chain|interface|if)\s*[:=]?\s*([a-z0-9\-_]+)/i);
  if (match) {
    const chainValue = match[1];
    if (!chainValue) {
      return null;
    }
    const chain = chainValue.toLowerCase();
    return chain === "wg" ? "chain:wireguard" : `chain:${chain}`;
  }
  // Try to extract interface name directly
  const ifMatch = text.match(/\b(em\d+|vtnet\d+|eth\d+|ens\d+|wireguard)\b/i);
  if (ifMatch) {
    const chainValue = ifMatch[1];
    if (!chainValue) {
      return null;
    }
    const chain = chainValue.toLowerCase();
    return chain === "wg" ? "chain:wireguard" : `chain:${chain}`;
  }
  return null;
}

export function detectFirewallIntent(userInput: string): FirewallIntent | null {
  const normalized = userInput.toLowerCase();
  const trimmed = normalized.trim();
  if (isActionRequest(userInput)) {
    // This is an action, not a query - let action intent detection handle it
    return null;
  }

  // Check for firewall-related keywords (query patterns)
  const hasFirewallKeywords =
    normalized.includes("firewall") ||
    normalized.includes("rule") ||
    normalized.includes("allow") ||
    normalized.includes("block") ||
    normalized.includes("exposed") ||
    normalized.includes("exposure") ||
    normalized.includes("port") ||
    normalized.includes("nat") ||
    normalized.includes("alias") ||
    normalized.includes("wireguard") ||
    /\bwg\b/i.test(normalized);

  if (!hasFirewallKeywords) {
    return null;
  }

  // Alias queries: "list ALL the aliases" (no specific name to extract, and
  // extractAliasName was never meant to find one) vs. "what's in the WG_VIP
  // alias" (contents of one named alias). Previously only the latter had a
  // dedicated intent, so "List all OPNsense firewall aliases." fell through
  // every other branch and landed on the generic list_rules fallback,
  // dumping firewall *rules* instead of aliases. See A-OP-02.
  const looksLikeAliasImpactQuestion =
    /\b(break|breaks|breaking|remov(?:e|ed|ing)|delet(?:e|ed|ing)|affect(?:s|ed|ing)?|impact)\b/.test(normalized);
  if (normalized.includes("alias") && !looksLikeAliasImpactQuestion) {
    // "aliases" (plural) with no specific name extractable reads as "list ALL
    // of them"; a specific name (singular "alias X", regardless of "all" used
    // loosely elsewhere in the sentence, e.g. "what ALL is in THE alias X")
    // always takes priority when extractAliasName finds one.
    const specificAliasName = extractAliasName(userInput);
    const mentionsAliasesPlural = /\baliases\b/.test(normalized);
    if (
      mentionsAliasesPlural &&
      !specificAliasName &&
      /\b(what|which|show|list|all|every)\b/.test(normalized)
    ) {
      return { type: "alias_list" };
    }

    // Alias content queries, e.g. "what all is in the alias tjs computers".
    if (specificAliasName && /\b(what|which|show|list|contents?|members?|entries?|in)\b/.test(normalized)) {
      return { type: "alias_contents", aliasName: specificAliasName };
    }
  }

  // Exposure map queries
  if (normalized.includes("exposure") || normalized.includes("exposed")) {
    const vmId = extractVmId(userInput);
    return { type: "exposure_map", vmId: vmId ?? undefined };
  }

  // Reachability from interface/chain (e.g. WireGuard)
  const reachabilityKeywords = normalized.includes("reachable") || normalized.includes("reach") || normalized.includes("accessible");
  const chain = extractChain(userInput);
  const asksForSources =
    /\b(?:what|which)\b.*\b(?:ips?|addresses?|sources?|subnets?)\b/.test(normalized) &&
    /\b(?:access|reach|connect|allowed|permit)\b/.test(normalized);
  if (asksForSources && chain) {
    const targetMatch = userInput.match(/\b(?:access|reach|connect\s+to)\s+(?:the\s+)?(.+?)(?:\?|$)/i);
    return {
      type: "sources_accessing_network",
      chain,
      target: targetMatch?.[1]?.trim() || "network",
    };
  }
  if (reachabilityKeywords && chain) {
    return { type: "reachability_from_chain", chain };
  }

  // Rule-attribution-by-port: "which firewall rule permits access to port 8006?",
  // "what rule blocks port 22?" — distinct from the "ports allowed from X to Y"
  // scope question below. Previously had no dedicated intent at all, so these
  // fell all the way through to the generic list_rules fallback (matched by
  // "rule" itself) — a full unfiltered rule dump instead of the one rule the
  // question was actually about, even though the port IS already present on
  // the ingested rule's dataJson. See C-03.
  const portNumberMatch = userInput.match(PORT_NUMBER_REGEX);
  const asksWhichRule = /\brule/.test(normalized) && /\b(which|what)\b/.test(normalized);
  if (portNumberMatch?.[1] && asksWhichRule) {
    return { type: "rules_by_port", port: portNumberMatch[1] };
  }

  // Port/service reachability: "what ports from X to Y?", "can port 22 come from home to lab?",
  // "is SSH open from X to Y?", "can X reach Y on port Z?"
  const KNOWN_SERVICES = ["ssh", "http", "https", "rdp", "smtp", "dns", "ntp", "ftp", "snmp"];
  const hasPortKeyword = normalized.includes("port") || normalized.includes("ports");
  const hasServiceKeyword = KNOWN_SERVICES.some(s => normalized.includes(s));
  const hasTrafficVerb =
    normalized.includes("allow") ||
    normalized.includes("reach") ||
    normalized.includes("come") ||
    normalized.includes("pass") ||
    normalized.includes("open") ||
    normalized.includes("accessible") ||
    normalized.includes("connect") ||
    normalized.includes("travel") ||
    normalized.includes("get through") ||
    normalized.includes("permitted");
  if ((hasPortKeyword || hasServiceKeyword) && hasTrafficVerb) {
    const scope = extractAllowedPortsScope(userInput);
    if (scope) {
      return { type: "allowed_ports_between", from: scope.from, to: scope.to };
    }
  }

  // Rules allowing/blocking subnet
  const subnet = extractSubnet(userInput);
  if (subnet) {
    if (normalized.includes("allow") || normalized.includes("permit") || normalized.includes("pass")) {
      return { type: "rules_allowing_subnet", subnet };
    }
    if (normalized.includes("block") || normalized.includes("deny") || normalized.includes("reject")) {
      return { type: "rules_blocking_subnet", subnet };
    }
  }

  // Rules by chain/interface
  if (chain) {
    return { type: "rules_by_chain", chain };
  }

  // Rule impact queries
  if (normalized.includes("impact") || normalized.includes("break")) {
    const ruleId = extractRuleId(userInput);
    if (ruleId) {
      return { type: "rule_impact", ruleId };
    }
  }

  // Count queries — must precede the list_rules fallback so "how many rules" doesn't dump
  const isCountQuery =
    /\bhow\s+many\b/.test(normalized) ||
    /\bcount\b.*\brules?\b/.test(normalized) ||
    /\btotal\b.*\brules?\b/.test(normalized);
  if (isCountQuery) {
    const direction =
      /\b(outgoing|out|egress)\b/.test(normalized) ? "out" :
      /\b(incoming|inbound|ingress)\b/.test(normalized) ? "in" :
      undefined;
    return { type: "count_rules", direction };
  }

  // Default: list all rules (also catch summarize/describe/explain without specific scope)
  if (
    /\b(list|show|rules?|summarize|describe|explain|overview|summary)\b/.test(normalized) ||
    /\ball\b/.test(normalized)
  ) {
    return { type: "list_rules" };
  }

  return null;
}
import {
  extractVmReference,
  isActionRequest,
} from "./detector-toolkit";
