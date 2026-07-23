import { getKnownEntities } from "./clarification";
import {
  extractNodeName,
  extractVmReference,
  isActionRequest,
} from "./detector-toolkit";

export type NetworkIntent =
  | { type: "describe_network" }
  | { type: "node_interfaces"; nodeName: string }
  | { type: "vms_by_subnet"; subnet: string }
  | { type: "reachability"; fromId: string }
  | { type: "vm_reachability"; vmId: string }
  | { type: "vm_networks"; vmNameOrId: string }
  | { type: "vm_by_ip"; ip: string }
  | { type: "vm_ip_by_name"; vmNameOrId: string }
  | { type: "vms_with_multiple_interfaces" }
  | { type: "switch_vlans" }
  | { type: "switch_ports_by_vlan"; vlan: number }
  | { type: "interface_lookup"; interfaceName: string };

const CIDR_REGEX = /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/;
const IP_REGEX = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const NETWORK_ENTITY_ID_REGEX = /network-if:[\w:-]+/i;
const VLAN_NUMBER_REGEX = /\bvlan\s+(\d+)\b/i;
// Linux persistent interface naming convention: "enx" + 12 hex chars (the
// interface's MAC address). Matched regardless of surrounding phrasing (bare
// "what is enx...?" vs. "what network interface is this? enx...") so a
// specific, real interface lookup never depends on the LLM recognizing the
// naming convention itself and hallucinating a plausible-sounding answer
// instead of querying the twin. See B-06.
const MAC_INTERFACE_REGEX = /\benx[0-9a-f]{12}\b/i;
const MULTI_NIC_PATTERNS = [
  /\btwo\s+nics?\b/i,
  /\bmultiple\s+nics?\b/i,
  /\bmulti[-\s]?nic\b/i,
  /\bmore\s+than\s+one\s+interface\b/i,
  /\btwo\s+interfaces?\b/i,
];

function extractVmNameOrId(text: string): string | null {
  return extractVmReference(text, { allowVmLabelName: true })?.raw ?? null;
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

  if (isActionRequest(userInput)) {
    // This is likely an action, not a query - let action intent detection handle it
    return null;
  }

  const macInterfaceMatch = userInput.match(MAC_INTERFACE_REGEX);
  if (macInterfaceMatch) {
    return { type: "interface_lookup", interfaceName: macInterfaceMatch[0] };
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
    // "what is the IP of sentinelZero" / "IP of X" – resolve VM by name then get IP
    const ipOfMatch = userInput.match(/(?:what is the )?ip (?:address )?of\s+([a-z0-9\-_]+)/i)
      || userInput.match(/(?:ip|address)\s+of\s+([a-z0-9\-_]+)/i);
    const vmForIp = ipOfMatch?.[1] ?? (vmNameOrId || extractKnownVmName(userInput));
    if (vmForIp) {
      return { type: "vm_ip_by_name", vmNameOrId: vmForIp };
    }
  }

  if ((normalized.includes("network") || normalized.includes("interfaces") || normalized.includes("nic")) && vmNameOrId) {
    return { type: "vm_networks", vmNameOrId };
  }

  if (normalized.includes("network") || normalized.includes("interfaces")) {
      const nodeName = extractNodeName(userInput, { allowRelations: false });
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
    const entityMatch = userInput.match(NETWORK_ENTITY_ID_REGEX);
    if (entityMatch?.[1]) {
      return { type: "reachability", fromId: entityMatch[1] };
    }
  }

  // VLAN/switch-port queries route to the switch twin data, not the generic
  // VM/node interface dump — see the "What VLANs are on the switch?" gap.
  if (normalized.includes("vlan")) {
    const vlanMatch = userInput.match(VLAN_NUMBER_REGEX);
    if (vlanMatch?.[1]) {
      return { type: "switch_ports_by_vlan", vlan: parseInt(vlanMatch[1], 10) };
    }
    return { type: "switch_vlans" };
  }

  // Only match subnet/routing if it's clearly a query (not an action).
  // Excludes "routing table" specifically: that's a live OPNsense diagnostic
  // (opnsense_readonly's diagnostics_routing_table action) the twin doesn't
  // model at all, so swallowing it into the generic interface-list fallback
  // here means the EXECUTE/LLM path — which could actually call that action —
  // never even sees the query. See A-OP-09.
  if (
    (normalized.includes("subnet") || normalized.includes("routing")) &&
    !isActionRequest(userInput) &&
    !/\brouting\s+table\b/.test(normalized)
  ) {
    return { type: "describe_network" };
  }

  return null;
}
