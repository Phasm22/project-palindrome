export type FirewallIntent =
  | { type: "list_rules" }
  | { type: "count_rules"; direction?: "in" | "out" }
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
  const match =
    text.match(/\bports?\b.*\bfrom\s+(.+?)\s+to\s+(.+?)(?:\?|$)/i) ??
    text.match(/\ballowed\b.*\bfrom\s+(.+?)\s+to\s+(.+?)(?:\?|$)/i);
  const from = match?.[1]?.trim();
  const to = match?.[2]?.trim();
  if (!from || !to) {
    return null;
  }
  return { from, to };
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
    normalized.includes("wireguard") ||
    /\bwg\b/i.test(normalized);

  if (!hasFirewallKeywords) {
    return null;
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

  // "What ports are allowed from X to Y?"
  if ((normalized.includes("port") || normalized.includes("ports")) && normalized.includes("allow")) {
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

  // Default: list all rules
  if (
    /\b(list|show|rules?)\b/.test(normalized) ||
    /\ball\b/.test(normalized)
  ) {
    return { type: "list_rules" };
  }

  return null;
}
