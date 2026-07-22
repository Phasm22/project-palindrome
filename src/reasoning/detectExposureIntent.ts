/**
 * Detects exposure/attack surface analysis intents from user queries.
 */

export type ExposureIntent =
  | { type: "vm_exposure"; vmId: string }
  | { type: "vms_exposed_to_subnet"; subnetCidr: string }
  | { type: "vm_reachability"; subnetCidr: string; vmId: string }
  | { type: "attack_path"; fromSubnet: string; toVmId: string }
  | { type: "internet_exposed" };

/**
 * Extract VM ID from text (e.g., "vm-101", "compute-vm:yin:101").
 */
function extractVmId(text: string): string | null {
  return extractVmReference(text, { allowQuotedName: true })?.raw ?? null;
}

/**
 * Extract subnet CIDR from text (e.g., "172.16.0.0/22", "192.168.1.0/24").
 */
function extractSubnetCidr(text: string): string | null {
  // Match CIDR notation
  const cidrMatch = text.match(/\b\d+\.\d+\.\d+\.\d+\/\d+\b/);
  if (cidrMatch) {
    return cidrMatch[0];
  }

  // Match "WAN", "internet", "external" as special cases
  const wanMatch = text.match(/\b(wan|internet|external)\b/i);
  if (wanMatch) {
    return "WAN"; // Special marker
  }

  return null;
}

/**
 * Detect exposure-related intent from user input.
 */
export function detectExposureIntent(userInput: string): ExposureIntent | null {
  if (isActionRequest(userInput)) return null;
  const lower = userInput.toLowerCase();

  // Check for VM exposure analysis
  if (
    (lower.includes("exposure") || lower.includes("attack surface") || lower.includes("security posture")) &&
    (lower.includes("vm") || lower.includes("virtual machine") || lower.includes("machine"))
  ) {
    const vmId = extractVmId(userInput);
    if (vmId) {
      // Normalize VM ID
      const normalizedVmId = vmId.includes(":") ? vmId : `compute-vm:${vmId}`;
      return { type: "vm_exposure", vmId: normalizedVmId };
    }
    // Could be asking for all VMs, but we'll handle that separately
  }

  // Check for "VMs exposed to subnet X"
  if (
    (lower.includes("exposed") || lower.includes("reachable") || lower.includes("accessible")) &&
    (lower.includes("subnet") || lower.includes("network") || lower.match(/\d+\.\d+\.\d+\.\d+\/\d+/))
  ) {
    const subnetCidr = extractSubnetCidr(userInput);
    if (subnetCidr) {
      const vmId = extractVmId(userInput);
      if (vmId) {
        const normalizedVmId = vmId.includes(":") ? vmId : `compute-vm:${vmId}`;
        return { type: "vm_reachability", subnetCidr, vmId: normalizedVmId };
      }
      return { type: "vms_exposed_to_subnet", subnetCidr };
    }
  }

  // Check for attack path queries
  if (
    (lower.includes("path") || lower.includes("route") || lower.includes("reach")) &&
    (lower.includes("from") || lower.includes("to"))
  ) {
    const fromSubnet = extractSubnetCidr(userInput);
    const toVmId = extractVmId(userInput);
    if (fromSubnet && toVmId) {
      const normalizedVmId = toVmId.includes(":") ? toVmId : `compute-vm:${toVmId}`;
      return { type: "attack_path", fromSubnet, toVmId: normalizedVmId };
    }
  }

  // Check for internet-exposed VMs
  if (
    (lower.includes("internet") || lower.includes("wan") || lower.includes("external")) &&
    (lower.includes("exposed") || lower.includes("accessible") || lower.includes("reachable"))
  ) {
    return { type: "internet_exposed" };
  }

  // Check for "which VMs are exposed" (general)
  if (
    lower.includes("which") &&
    (lower.includes("vm") || lower.includes("virtual machine")) &&
    (lower.includes("exposed") || lower.includes("accessible"))
  ) {
    // Default to internet exposure if no subnet specified
    const subnetCidr = extractSubnetCidr(userInput);
    if (subnetCidr) {
      return { type: "vms_exposed_to_subnet", subnetCidr };
    }
    return { type: "internet_exposed" };
  }

  return null;
}
import { extractVmReference, isActionRequest } from "./detector-toolkit";
