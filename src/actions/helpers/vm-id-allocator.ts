/**
 * VM ID Allocator
 * 
 * Allocates VM IDs from a high-number range, checking availability
 * against Proxmox cluster resources.
 */

import { ProxmoxClient } from "../../tools/proxmox/client";
import { pceLogger as logger } from "../../pce/utils/logger";

export interface VmIdAllocationOptions {
  /** Starting VM ID for allocation range (default: 9000) */
  startId?: number;
  /** Ending VM ID for allocation range (default: 9999) */
  endId?: number;
  /** Preferred VM ID (will use if available, otherwise finds next available) */
  preferredId?: number;
  /** Maximum attempts to find available ID (default: 100) */
  maxAttempts?: number;
}

export interface VmIdAllocationResult {
  /** Allocated VM ID */
  vmId: number;
  /** Whether the preferred ID was used */
  usedPreferred: boolean;
  /** Number of attempts made */
  attempts: number;
}

/**
 * Get all used VM IDs from Proxmox cluster
 */
async function getUsedVmIds(
  client: ProxmoxClient
): Promise<Set<number>> {
  try {
    const response = await client.get("/cluster/resources");
    const resources = response.data?.data || [];
    
    // Extract all VM IDs (both QEMU and LXC)
    const usedIds = new Set<number>();
    for (const resource of resources) {
      if ((resource.type === "qemu" || resource.type === "lxc") && resource.vmid) {
        usedIds.add(resource.vmid);
      }
    }
    
    logger.debug("Retrieved used VM IDs from Proxmox", { 
      count: usedIds.size,
      sampleIds: Array.from(usedIds).slice(0, 10).sort((a, b) => a - b)
    });
    
    return usedIds;
  } catch (error: any) {
    logger.warn("Failed to get used VM IDs from Proxmox, will use fallback", {
      error: error.message
    });
    // Return empty set - we'll try anyway and let Terraform/Proxmox handle conflicts
    return new Set<number>();
  }
}

/**
 * Allocate an available VM ID from the specified range
 * 
 * Strategy:
 * 1. If preferredId is provided and available, use it
 * 2. Otherwise, find next available ID in range [startId, endId]
 * 3. If range is exhausted, try fallback ranges
 * 4. If all fails, let Terraform auto-assign (vm_id = null)
 */
export async function allocateVmId(
  client: ProxmoxClient,
  options: VmIdAllocationOptions = {}
): Promise<VmIdAllocationResult | null> {
  const {
    startId = 9000,
    endId = 9999,
    preferredId,
    maxAttempts = 100,
  } = options;

  // Validate range
  if (startId < 100 || endId > 999999 || startId > endId) {
    logger.error("Invalid VM ID range", { startId, endId });
    return null;
  }

  // Get used VM IDs from Proxmox
  const usedIds = await getUsedVmIds(client);

  // Strategy 1: Use preferred ID if provided and available
  if (preferredId !== undefined) {
    if (preferredId >= startId && preferredId <= endId && !usedIds.has(preferredId)) {
      logger.info("Using preferred VM ID", { vmId: preferredId });
      return {
        vmId: preferredId,
        usedPreferred: true,
        attempts: 1,
      };
    } else if (usedIds.has(preferredId)) {
      logger.warn("Preferred VM ID is already in use", { 
        preferredId,
        usedIds: Array.from(usedIds).slice(0, 10)
      });
    }
  }

  // Strategy 2: Find next available ID in range
  let attempts = 0;
  for (let candidateId = startId; candidateId <= endId && attempts < maxAttempts; candidateId++) {
    attempts++;
    
    if (!usedIds.has(candidateId)) {
      logger.info("Allocated VM ID from range", { 
        vmId: candidateId,
        range: `${startId}-${endId}`,
        attempts
      });
      return {
        vmId: candidateId,
        usedPreferred: false,
        attempts,
      };
    }
  }

  // Strategy 3: Try fallback ranges if primary range is exhausted
  const fallbackRanges = [
    { start: 8000, end: 8999 },  // Just below primary range
    { start: 7000, end: 7999 },  // Further fallback
    { start: 6000, end: 6999 },  // Even further fallback
  ];

  for (const fallback of fallbackRanges) {
    for (let candidateId = fallback.start; candidateId <= fallback.end && attempts < maxAttempts; candidateId++) {
      attempts++;
      
      if (!usedIds.has(candidateId)) {
        logger.info("Allocated VM ID from fallback range", { 
          vmId: candidateId,
          range: `${fallback.start}-${fallback.end}`,
          attempts
        });
        return {
          vmId: candidateId,
          usedPreferred: false,
          attempts,
        };
      }
    }
  }

  // Strategy 4: If all ranges exhausted, return null to let Terraform auto-assign
  logger.warn("Could not find available VM ID in any range, will let Terraform auto-assign", {
    primaryRange: `${startId}-${endId}`,
    attempts,
    usedCount: usedIds.size
  });
  
  return null; // Terraform will auto-assign when vm_id = null
}

/**
 * Check if a specific VM ID is available
 */
export async function isVmIdAvailable(
  client: ProxmoxClient,
  vmId: number
): Promise<boolean> {
  const usedIds = await getUsedVmIds(client);
  return !usedIds.has(vmId);
}

