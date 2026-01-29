export type FirewallIntent =
  | { type: "list_rules" }
  | { type: "rules_by_chain"; chain: string }
  | { type: "rules_allowing_subnet"; subnet: string }
  | { type: "rules_blocking_subnet"; subnet: string }
  | { type: "exposure_map"; vmId?: string }
  | { type: "reachability_from_chain"; chain: string }
  | { type: "rule_impact"; ruleId: string };

const CIDR_REGEX = /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/;
const VM_ID_REGEX = /(?:vm|vm-)(\d+)|compute-vm:[\w:-]+/i;
const RULE_ID_REGEX = /\bfw-rule:[a-z0-9:._-]+/i;

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

function extractChain(text: string): string | null {
  const match = text.match(/\b(?:chain|interface|if)\s*[:=]?\s*([a-z0-9\-_]+)/i);
  if (match) {
    return `chain:${match[1]}`;
  }
  // Try to extract interface name directly
  const ifMatch = text.match(/\b(em\d+|vtnet\d+|eth\d+|ens\d+)/i);
  if (ifMatch) {
    return `chain:${ifMatch[1]}`;
  }
  return null;
}

export function detectFirewallIntent(userInput: string): FirewallIntent | null {
  const normalized = userInput.toLowerCase();

  // Skip if this looks like an action request (configure/setup/allow port on VM)
  // Action intents are handled separately and take priority
  const hasActionKeywords = 
    (normalized.includes("configure") || normalized.includes("setup") || normalized.includes("set")) &&
    (normalized.includes("firewall") || normalized.includes("port"));
  
  const hasAllowPortOnVm = 
    normalized.includes("allow") && 
    normalized.includes("port") && 
    (normalized.includes("on ") || normalized.match(/\b(on|for|to)\s+[a-z0-9\-_]+/i));
  
  if (hasActionKeywords || hasAllowPortOnVm) {
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
    normalized.includes("nat");

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

  // Default: list all rules
  if (
    normalized.includes("list") ||
    normalized.includes("show") ||
    normalized.includes("all") ||
    normalized.includes("rules")
  ) {
    return { type: "list_rules" };
  }

  return null;
}

