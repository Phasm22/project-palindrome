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

  if (normalized.includes("network") || normalized.includes("interfaces")) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "node_interfaces", nodeName };
    }
    if (/\bcluster\b/.test(normalized) || normalized.includes("all interfaces")) {
      return { type: "describe_network" };
    }
  }

  const cidrMatch = userInput.match(CIDR_REGEX);
  if (cidrMatch) {
    return { type: "vms_by_subnet", subnet: cidrMatch[0] };
  }

  if (normalized.includes("reach") || normalized.includes("reachable") || normalized.includes("connectivity")) {
    const entityMatch = userInput.match(ENTITY_ID_REGEX);
    if (entityMatch) {
      return { type: "reachability", fromId: entityMatch[1] };
    }
  }

  if (normalized.includes("vlan") || normalized.includes("subnet") || normalized.includes("routing")) {
    return { type: "describe_network" };
  }

  return null;
}

