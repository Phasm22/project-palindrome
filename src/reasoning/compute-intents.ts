export type ComputeIntent =
  | { type: "describe_cluster" }
  | { type: "vms_by_node"; nodeName: string }
  | { type: "vms_without_agent" }
  | { type: "stopped_vms_on_node"; nodeName: string }
  | { type: "find_vm_by_id"; vmId: number };

function extractNodeName(text: string): string | null {
  // Try "node <name>" first
  const nodeMatch = text.match(/\bnode\s+([a-z0-9\-_]+)/i);
  if (nodeMatch) {
    return nodeMatch[1];
  }

  // Try "between <name>"
  const relationMatch = text.match(/\bbetween\s+([a-z0-9\-_]+)/i);
  if (relationMatch) {
    return relationMatch[1];
  }

  // Try "on <name>" - this is the most common pattern
  // Match "on Yang", "on yin", "on proxBig", etc.
  const onMatch = text.match(/\bon\s+([a-z0-9\-_]+)/i);
  if (onMatch) {
    return onMatch[1];
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
      const id = parseInt(match[1], 10);
      if (!isNaN(id) && id > 0) {
        return id;
      }
    }
  }
  
  return null;
}

export function detectComputeIntent(userInput: string): ComputeIntent | null {
  const normalized = userInput.toLowerCase();

  // Check for node-specific queries FIRST (before general "all VMs" pattern)
  // This ensures "what are all the VMs on node yin?" matches vms_by_node, not describe_cluster
  if ((normalized.includes("what are") || normalized.includes("show") || normalized.includes("list") || 
       normalized.includes("which")) && normalized.includes("vm") && 
      (normalized.includes("on") || normalized.includes("node"))) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "vms_by_node", nodeName };
    }
  }

  if (normalized.includes("describe") && normalized.includes("cluster")) {
    return { type: "describe_cluster" };
  }

  // Match "all VMs" or "all virtual machines" (whole word "all", not substring)
  // BUT only if NOT asking about a specific node
  if (/\ball\b/.test(normalized) && (normalized.includes("vm") || normalized.includes("virtual machine"))) {
    // Check if this is asking about a specific node - if so, use vms_by_node instead
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "vms_by_node", nodeName };
    }
    return { type: "describe_cluster" };
  }

  if (normalized.includes("guest agent")) {
    return { type: "vms_without_agent" };
  }

  if (normalized.includes("relationship") && normalized.includes("hosted")) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "vms_by_node", nodeName };
    }
  }

  if (normalized.includes("stopped")) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "stopped_vms_on_node", nodeName };
    }
  }

  if (normalized.includes("which vms") || normalized.includes("list vms")) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "vms_by_node", nodeName };
    }
  }

  // Handle queries about VM IDs on a node: "what are the vm ids on yang?", "vm ids on node", etc.
  if ((normalized.includes("vm id") || normalized.includes("vmids") || normalized.includes("vm ids")) && 
      (normalized.includes("on") || normalized.includes("node"))) {
    const nodeName = extractNodeName(userInput);
    if (nodeName) {
      return { type: "vms_by_node", nodeName };
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

