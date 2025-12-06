export type NetworkIntent =
  | { type: "describe_network" }
  | { type: "node_interfaces"; nodeName: string }
  | { type: "vms_by_subnet"; subnet: string }
  | { type: "reachability"; fromId: string };

const CIDR_REGEX = /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/;
const ENTITY_ID_REGEX = /(network-if:[\w:-]+|compute-vm:[\w:-]+)/i;

function extractNodeName(text: string): string | null {
  const match = text.match(/\b(?:node|host)\s+([a-z0-9\-_]+)/i);
  return match ? match[1] : null;
}

export function detectNetworkIntent(userInput: string): NetworkIntent | null {
  const normalized = userInput.toLowerCase();

  // Don't match network intent if this is clearly an action (create, install, configure, etc.)
  // Action intents should take priority
  const hasActionKeyword = 
    normalized.includes("create") || 
    normalized.includes("install") || 
    normalized.includes("configure") || 
    normalized.includes("set") ||
    normalized.includes("destroy") ||
    normalized.includes("delete") ||
    normalized.includes("sync") ||
    normalized.includes("put") ||
    normalized.includes("assign");
  
  if (hasActionKeyword) {
    // This is likely an action, not a query - let action intent detection handle it
    return null;
  }

  if (normalized.includes("network") || normalized.includes("interfaces")) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "node_interfaces", nodeName };
    }
    if (/\bcluster\b/.test(normalized) || normalized.includes("all interfaces")) {
      return { type: "describe_network" };
    }
  }

  // Only match CIDR for network intent if it's clearly a network/subnet query
  // Don't match if it's about firewall rules (those are handled by firewall intent)
  const cidrMatch = userInput.match(CIDR_REGEX);
  if (cidrMatch && !userInput.toLowerCase().includes("rule") && !userInput.toLowerCase().includes("allow") && !userInput.toLowerCase().includes("block")) {
    return { type: "vms_by_subnet", subnet: cidrMatch[0] };
  }

  if (normalized.includes("reach") || normalized.includes("reachable") || normalized.includes("connectivity")) {
    const entityMatch = userInput.match(ENTITY_ID_REGEX);
    if (entityMatch) {
      return { type: "reachability", fromId: entityMatch[1] };
    }
  }

  // Only match VLAN/subnet/routing if it's clearly a query (not an action)
  if ((normalized.includes("vlan") || normalized.includes("subnet") || normalized.includes("routing")) && !hasActionKeyword) {
    return { type: "describe_network" };
  }

  return null;
}

