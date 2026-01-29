import { getKnownEntities } from "./clarification";

export type NetworkIntent =
  | { type: "describe_network" }
  | { type: "node_interfaces"; nodeName: string }
  | { type: "vms_by_subnet"; subnet: string }
  | { type: "reachability"; fromId: string }
  | { type: "vm_reachability"; vmId: string }
  | { type: "vm_networks"; vmNameOrId: string }
  | { type: "vm_by_ip"; ip: string }
  | { type: "vms_with_multiple_interfaces" };

const CIDR_REGEX = /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/;
const IP_REGEX = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const ENTITY_ID_REGEX = /(network-if:[\w:-]+|compute-vm:[\w:-]+)/i;
const VM_NAME_REGEX = /\bvm\s+([a-z0-9\-_]+)/i;
const MULTI_NIC_PATTERNS = [
  /\btwo\s+nics?\b/i,
  /\bmultiple\s+nics?\b/i,
  /\bmulti[-\s]?nic\b/i,
  /\bmore\s+than\s+one\s+interface\b/i,
  /\btwo\s+interfaces?\b/i,
];

function extractNodeName(text: string): string | null {
  const match = text.match(/\b(?:node|host)\s+([a-z0-9\-_]+)/i);
  return match ? match[1] : null;
}

function extractVmNameOrId(text: string): string | null {
  const idMatch = text.match(ENTITY_ID_REGEX);
  if (idMatch && idMatch[0].startsWith("compute-vm:")) {
    return idMatch[0];
  }
  const nameMatch = text.match(VM_NAME_REGEX);
  return nameMatch ? nameMatch[1] : null;
}

function extractKnownVmName(text: string): string | null {
  const { vms } = getKnownEntities();
  if (!vms.length) return null;
  const normalized = text.toLowerCase();
  const matched = vms.find((vm) => vm.name && normalized.includes(vm.name.toLowerCase()));
  return matched?.name ?? null;
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

  const vmNameOrId = extractVmNameOrId(userInput) || extractKnownVmName(userInput);

  if (MULTI_NIC_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { type: "vms_with_multiple_interfaces" };
  }

  if (normalized.includes("ip") || normalized.includes("ip address")) {
    const ipMatch = userInput.match(IP_REGEX);
    if (ipMatch) {
      return { type: "vm_by_ip", ip: ipMatch[0] };
    }
  }

  if ((normalized.includes("network") || normalized.includes("interfaces") || normalized.includes("nic")) && vmNameOrId) {
    return { type: "vm_networks", vmNameOrId };
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
    if (vmNameOrId) {
      const vmId = vmNameOrId.startsWith("compute-vm:") ? vmNameOrId : vmNameOrId;
      return { type: "vm_reachability", vmId };
    }
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
