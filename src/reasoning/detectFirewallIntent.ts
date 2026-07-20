export type FirewallIntent =
  | { type: "list_rules" }
  | { type: "count_rules"; direction?: "in" | "out" }
  | { type: "alias_contents"; aliasName: string }
  | { type: "allowed_ports_between"; from: string; to: string }
  | { type: "rules_by_chain"; chain: string }
  | { type: "rules_allowing_subnet"; subnet: string }
  | { type: "rules_blocking_subnet"; subnet: string }
  | { type: "exposure_map"; vmId?: string }
  | { type: "reachability_from_chain"; chain: string }
  | { type: "rule_impact"; ruleId: string };

const CIDR_REGEX = /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/;
const VM_ID_REGEX = /(?:vm|vm-)(\d+)|compute-vm:[\w:-]+/i;
const RULE_ID_REGEX = /\bfw-rule:[a-z0-9:._-]+/i;
const WIREGUARD_PATTERN = /\b(?:wireguard|wg)\b/i;

function extractSubnet(text: string): string | null {
  const match = text.match(CIDR_REGEX);
  return match ? match[0] : null;
}

function extractVmId(text: string): string | null {
  const match = text.match(VM_ID_REGEX);
  if (match) {
    if (match[1]) {
      return `compute-vm:proxbig:${match[1]}`;
    }
    return match[0];
  }
  return null;
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

function cleanAliasName(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.?!]+$/g, "")
    .trim();
  return cleaned || null;
}

function extractAliasName(text: string): string | null {
  const aliasAfterMatch = text.match(/\balias\s+["'`]?(.+?)(?:["'`]?\s*(?:contents?|members?|entries?)\b|[.?!]|$)/i);
  if (aliasAfterMatch?.[1]) {
    return cleanAliasName(aliasAfterMatch[1]);
  }

  const aliasBeforeMatch = text.match(/\b(?:contents?|members?|entries?)\s+(?:of|in|for)\s+(?:the\s+)?alias\s+["'`]?(.+?)(?:["'`]?[.?!]|$)/i);
  if (aliasBeforeMatch?.[1]) {
    return cleanAliasName(aliasBeforeMatch[1]);
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
  const isQuestion = trimmed.endsWith("?") || /^(what|which|how|is|are|do|does|can|could|would|will)\b/.test(trimmed);

  // Skip if this looks like an action request (configure/setup/allow port on VM)
  // Action intents are handled separately and take priority
  const hasActionKeywords = 
    (normalized.includes("configure") || normalized.includes("setup") || normalized.includes("set")) &&
    (normalized.includes("firewall") || normalized.includes("port"));

  const vmTargetMatch = normalized.match(/\b(?:on|for|to)\s+(?:vm\s+)?([a-z0-9\-_]+)/i);
  const vmTarget = vmTargetMatch?.[1]?.toLowerCase() ?? "";
  const nonVmTargets = new Set(["the", "a", "an", "home", "lab", "network", "subnet"]);
  const hasAllowPortOnVm =
    !isQuestion &&
    normalized.includes("allow") &&
    normalized.includes("port") &&
    vmTarget.length > 0 &&
    !nonVmTargets.has(vmTarget);

  if ((hasActionKeywords && !isQuestion) || hasAllowPortOnVm) {
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

  // Alias content queries, e.g. "what all is in the alias tjs computers".
  if (normalized.includes("alias") && /\b(what|which|show|list|contents?|members?|entries?|in)\b/.test(normalized)) {
    const aliasName = extractAliasName(userInput);
    if (aliasName) {
      return { type: "alias_contents", aliasName };
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
  if (reachabilityKeywords && chain) {
    return { type: "reachability_from_chain", chain };
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
