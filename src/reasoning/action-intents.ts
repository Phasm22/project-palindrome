/**
 * Action Intent Detection
 * 
 * Detects user intents for infrastructure actions (create VM, configure network, etc.)
 */

export type ActionIntent =
  | { type: "create_vm"; name: string; node: string }
  | { type: "destroy_vm"; name?: string; vmId?: number }
  | { type: "start_vm"; name: string }
  | { type: "stop_vm"; name: string }
  | { type: "sync_dhcp_to_dns" };

function extractVmName(text: string): string | null {
  // Match patterns like "create VM named X", "create a VM called X", "VM named X"
  const namedMatch = text.match(/\b(?:vm|virtual machine)\s+(?:named|called|with name)\s+([a-z0-9\-_]+)/i);
  if (namedMatch) {
    return namedMatch[1];
  }

  // Match patterns like "create X", "create a X" where X is a VM name
  const createMatch = text.match(/\bcreate\s+(?:a\s+)?(?:vm\s+)?([a-z0-9\-_]+)/i);
  if (createMatch) {
    return createMatch[1];
  }

  // Match patterns like "destroy X", "delete X", "remove X" where X is a VM name
  const destroyMatch = text.match(/\b(?:destroy|delete|remove)\s+(?:vm\s+)?([a-z0-9\-_]+)/i);
  if (destroyMatch) {
    return destroyMatch[1];
  }

  return null;
}

function extractVmId(text: string): number | null {
  // Match patterns like "vm 104", "vmid 104", "vm id 104", "virtual machine 104"
  const vmIdMatch = text.match(/\b(?:vm|vmid|vm\s+id|virtual\s+machine)\s+(\d+)/i);
  if (vmIdMatch) {
    return parseInt(vmIdMatch[1], 10);
  }

  // Match standalone numbers after destroy/delete/remove
  const destroyIdMatch = text.match(/\b(?:destroy|delete|remove)\s+(?:vm\s+)?(\d+)/i);
  if (destroyIdMatch) {
    return parseInt(destroyIdMatch[1], 10);
  }

  return null;
}

function extractNodeName(text: string): string | null {
  // Match patterns like "on node X", "on X", "node X"
  const onMatch = text.match(/\bon\s+(?:node\s+)?([a-z0-9\-_]+)/i);
  if (onMatch) {
    return onMatch[1];
  }

  return null;
}

/**
 * Detect action intent from user input
 */
export function detectActionIntent(userInput: string): ActionIntent | null {
  const normalized = userInput.toLowerCase();

  // Create VM
  if (
    (normalized.includes("create") || normalized.includes("spin up") || normalized.includes("provision")) &&
    (normalized.includes("vm") || normalized.includes("virtual machine"))
  ) {
    const vmName = extractVmName(userInput);
    const nodeName = extractNodeName(userInput);

    if (vmName && nodeName) {
      return { type: "create_vm", name: vmName, node: nodeName };
    }
  }

  // Destroy/Delete VM
  if (
    normalized.includes("destroy") || normalized.includes("delete") || normalized.includes("remove")
  ) {
    // Try to extract VM ID first (more specific)
    const vmId = extractVmId(userInput);
    if (vmId) {
      return { type: "destroy_vm", vmId };
    }
    
    // Fall back to VM name extraction
    const vmName = extractVmName(userInput);
    if (vmName) {
      return { type: "destroy_vm", name: vmName };
    }
  }

  // Start VM
  if (
    (normalized.includes("start") || normalized.includes("boot")) &&
    (normalized.includes("vm") || normalized.includes("virtual machine"))
  ) {
    const vmName = extractVmName(userInput);
    if (vmName) {
      return { type: "start_vm", name: vmName };
    }
  }

  // Stop VM
  if (
    (normalized.includes("stop") || normalized.includes("shutdown")) &&
    (normalized.includes("vm") || normalized.includes("virtual machine"))
  ) {
    const vmName = extractVmName(userInput);
    if (vmName) {
      return { type: "stop_vm", name: vmName };
    }
  }

  // Sync DHCP to DNS
  if (
    (normalized.includes("sync") || normalized.includes("update") || normalized.includes("register")) &&
    (normalized.includes("dhcp") || normalized.includes("lease")) &&
    (normalized.includes("dns") || normalized.includes("domain"))
  ) {
    return { type: "sync_dhcp_to_dns" };
  }

  return null;
}

