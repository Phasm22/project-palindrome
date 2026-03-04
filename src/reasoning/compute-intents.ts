type VmKind = "qemu" | "lxc" | "all";

export type ComputeIntent =
  | { type: "describe_cluster" }
  | { type: "list_all_vms"; vmKind?: VmKind }
  | { type: "vms_by_node"; nodeName: string; vmKind?: VmKind }
  | { type: "running_vms_on_node"; nodeName: string; vmKind?: VmKind }
  | { type: "find_vm_by_name"; vmName: string; vmKind?: VmKind }
  | { type: "vms_without_agent" }
  | { type: "stopped_vms_on_node"; nodeName: string; vmKind?: VmKind }
  | { type: "find_vm_by_id"; vmId: number };

const KNOWN_NODE_NAMES = new Set(["yang", "yin", "proxbig", "pve1", "pve2"]);

function extractVmNameForLocationQuery(text: string): string | null {
  const normalized = text.toLowerCase().trim();
  // "Is opnsense running and which node hosts it?" -> capture "opnsense" from "is X running"
  const isRunningMatch = text.match(/\bis\s+([a-z0-9\-_]+)\s+running\b/i);
  if (isRunningMatch && (normalized.includes("which node hosts") || normalized.includes("node hosts"))) {
    const name = isRunningMatch[1];
    if (name && name !== "it" && name.length > 1) {
      return name;
    }
  }
  // "Which node hosts opnsense?" -> capture "opnsense"
  const hostsMatch = text.match(/\b(?:which\s+)?node\s+hosts\s+([a-z0-9\-_]+)/i);
  if (hostsMatch) {
    const name = hostsMatch[1]?.toLowerCase();
    if (name && name !== "it") {
      return hostsMatch[1] ?? null;
    }
  }
  // "Where is opnsense running?" -> capture "opnsense"
  const whereMatch = text.match(/\bwhere\s+is\s+([a-z0-9\-_]+)\s+(?:running|hosted)?/i);
  if (whereMatch && whereMatch[1]) {
    return whereMatch[1];
  }
  return null;
}

function extractNodeName(text: string): string | null {
  // Try "node <name>" first
  const nodeMatch = text.match(/\bnode\s+([a-z0-9\-_]+)/i);
  if (nodeMatch) {
    return nodeMatch[1] ?? null;
  }

  // Try "between <name>"
  const relationMatch = text.match(/\bbetween\s+([a-z0-9\-_]+)/i);
  if (relationMatch) {
    return relationMatch[1] ?? null;
  }

  // Try "on <name>" - this is the most common pattern
  // Match "on Yang", "on yin", "on proxBig", etc.
  const onMatch = text.match(/\bon\s+([a-z0-9\-_]+)/i);
  if (onMatch) {
    return onMatch[1] ?? null;
  }

  // Try to find node names directly (yang, yin, proxbig, etc.)
  // This helps with queries like "vm ids on yang" where "on" might be implicit
  const knownNodes = ['yang', 'yin', 'proxbig', 'proxbig', 'pve1', 'pve2'];
  const lowerText = text.toLowerCase();
  for (const node of knownNodes) {
    if (lowerText.includes(node) && (lowerText.includes('vm') || lowerText.includes('node'))) {
      return node;
    }
  }

  return null;
}

function extractVmId(text: string): number | null {
  // Match patterns like "vm 101", "vm id 101", "vm-id 101", "vm101", etc.
  // Look for "vm" followed by optional "id" or "-" and then a number
  const patterns = [
    /\bvm\s+id\s+(\d+)/i,
    /\bvm\s*-?\s*id\s+(\d+)/i,
    /\bvm\s+(\d+)/i,
    /\bvm\s*-?\s*(\d+)/i,
    /\bvm(\d+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const idText = match[1];
      if (!idText) {
        continue;
      }
      const id = parseInt(idText, 10);
      if (!isNaN(id) && id > 0) {
        return id;
      }
    }
  }
  
  return null;
}

function detectVmKind(text: string): VmKind | undefined {
  const normalized = text.toLowerCase();
  const mentionsVm =
    /\bvm(s)?\b/.test(normalized) ||
    normalized.includes("virtual machine");
  const mentionsContainer = /\b(container|containers|lxc|ct|cts)\b/.test(normalized);

  if (mentionsVm && mentionsContainer) {
    return "all";
  }
  if (mentionsContainer) {
    return "lxc";
  }
  if (mentionsVm) {
    return "qemu";
  }
  return undefined;
}

export function detectComputeIntent(userInput: string): ComputeIntent | null {
  const normalized = userInput.toLowerCase();
  const vmKind = detectVmKind(userInput);
  const hasVmOrContainer = vmKind !== undefined;

  // "Is X running and which node hosts it?" / "which node hosts X?" / "where is X running?" -> find VM by name
  const vmNameForLocation = extractVmNameForLocationQuery(userInput);
  if (vmNameForLocation) {
    return { type: "find_vm_by_name", vmName: vmNameForLocation, vmKind };
  }

  // Running VMs on a node: "what is running on yang?", "which vms are running on yin?" (node must be a known node name)
  if (
    (normalized.includes("running") || normalized.includes("run ")) &&
    (normalized.includes("on") || normalized.includes("node")) &&
    !normalized.includes("temperature") &&
    !normalized.includes("temp")
  ) {
    const nodeName = extractNodeName(userInput);
    if (nodeName && KNOWN_NODE_NAMES.has(nodeName.toLowerCase())) {
      return { type: "running_vms_on_node", nodeName, vmKind };
    }
  }

  // Check for node-specific queries FIRST (before general "all VMs" pattern)
  // This ensures "what are all the VMs on node yin?" matches vms_by_node, not describe_cluster
  if ((normalized.includes("what are") || normalized.includes("show") || normalized.includes("list") || 
       normalized.includes("which")) && hasVmOrContainer && 
      (normalized.includes("on") || normalized.includes("node"))) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "vms_by_node", nodeName, vmKind };
    }
  }

  if (normalized.includes("describe") && normalized.includes("cluster")) {
    return { type: "describe_cluster" };
  }

  // "VM counts per node" / "show counts per node" / "how many vms per node" → describe_cluster (summary), not list_all_vms (full dump)
  if (
    (normalized.includes("count") || normalized.includes("how many")) &&
    (normalized.includes("per node") || normalized.includes("per-node") || (normalized.includes("node") && (normalized.includes("vm") || normalized.includes("container"))))
  ) {
    return { type: "describe_cluster" };
  }

  // Match "all VMs" or "all virtual machines" or "list all containers" (whole word "all", not substring)
  // BUT only if NOT asking about a specific node
  if (/\ball\b/.test(normalized) && (normalized.includes("vm") || normalized.includes("virtual machine") || normalized.includes("container") || normalized.includes("lxc"))) {
    // Check if this is asking about a specific node - if so, use vms_by_node instead
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "vms_by_node", nodeName, vmKind };
    }
    return { type: "list_all_vms", vmKind };
  }

  // Match "list containers" or "list vms" without "all"
  if ((normalized.includes("list") || normalized.includes("show")) && hasVmOrContainer) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "vms_by_node", nodeName, vmKind };
    }
    return { type: "list_all_vms", vmKind };
  }

  if (normalized.includes("guest agent")) {
    return { type: "vms_without_agent" };
  }

  if (normalized.includes("relationship") && normalized.includes("hosted")) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "vms_by_node", nodeName, vmKind };
    }
  }

  if (normalized.includes("stopped")) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "stopped_vms_on_node", nodeName, vmKind };
    }
  }

  if (normalized.includes("which vms") || normalized.includes("list vms") || normalized.includes("list containers") || normalized.includes("which containers")) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "vms_by_node", nodeName, vmKind };
    }
  }

  // Handle queries about VM IDs on a node: "what are the vm ids on yang?", "vm ids on node", etc.
  if ((normalized.includes("vm id") || normalized.includes("vmids") || normalized.includes("vm ids")) && 
      (normalized.includes("on") || normalized.includes("node"))) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "vms_by_node", nodeName, vmKind };
    }
  }

  // These are now handled above in the priority check

  // Handle queries about a specific VM by ID: "what is vm 101?", "what is the name of vm 101?", "tell me about vm 101", etc.
  // Only match if it's NOT asking about VMs on a specific node (those are handled above)
  if ((normalized.includes("what is") || normalized.includes("what's") || normalized.includes("tell me about") || 
       normalized.includes("name of") || normalized.includes("describe")) && 
      normalized.includes("vm")) {
    // Check if it's asking about a specific VM ID (not about VMs on a node)
    if (!normalized.includes("on") && !normalized.includes("node")) {
      const vmId = extractVmId(userInput);
      if (vmId !== null) {
        return { type: "find_vm_by_id", vmId };
      }
    }
  }

  // Handle direct VM ID queries: "vm 101", "vm id 101", etc. (when not asking about a node)
  if (normalized.includes("vm") && !normalized.includes("on") && !normalized.includes("node")) {
    const vmId = extractVmId(userInput);
    if (vmId !== null) {
      return { type: "find_vm_by_id", vmId };
    }
  }

  return null;
}

