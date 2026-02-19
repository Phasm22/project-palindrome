import { z } from "zod";
import { OpnsenseReadOnlyTool } from "../../tools/opnsense/readonly/opnsense-readonly-tool";
import { pceLogger as logger } from "../../pce/utils/logger";
import { ProxmoxClient } from "../../tools/proxmox/client";

/**
 * Set Interface VLAN Action Schema
 */
export const SetInterfaceVlanSchema = z.object({
  vmid: z.number().int().positive(),
  node: z.string().min(1, "Node name is required"),
  vlanId: z.number().int().min(1).max(4094, "VLAN ID must be between 1 and 4094"),
  bridge: z.string().default("vmbr0"), // Bridge to use (e.g., vmbr0, vmbr2)
  dryRun: z.boolean().default(false),
});

export type SetInterfaceVlanParams = z.infer<typeof SetInterfaceVlanSchema>;

export interface SetInterfaceVlanResult {
  success: boolean;
  message: string;
  vmid?: number;
  vlanId?: number;
  bridge?: string;
}

/**
 * Get ProxmoxClient config for a specific node
 */
function getProxmoxClientConfig(node: string): { url: string; tokenId: string; tokenSecret: string } {
  const nodeLower = node.toLowerCase();
  
  let url: string;
  let tokenId: string | undefined;
  let tokenSecret: string | undefined;
  
  if (nodeLower === "yin" || nodeLower === "yang") {
    url = nodeLower === "yin"
      ? process.env.PROXMOX_YIN_URL || process.env.PROXMOX_URL || ""
      : process.env.PROXMOX_YANG_URL || process.env.PROXMOX_URL || "";
    tokenId = process.env.CLUSTER_TF_TOKEN_ID;
    if (nodeLower === "yin") {
      tokenSecret = process.env.PROXMOX_YIN_TF_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
    } else {
      tokenSecret = process.env.PROXMOX_YANG_TF_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
    }
  } else {
    url = process.env.PROXMOX_URL || "";
    tokenId = process.env.CLUSTER_TF_TOKEN_ID || process.env.PROXBIG_TF_TOKEN_ID;
    tokenSecret = process.env.PROXMOX_PROXBIG_TF_SECRET || process.env.PROXBIG_TF_SECRET || process.env.PROXBIG_TOKEN_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
  }
  
  if (!url || !tokenId || !tokenSecret) {
    throw new Error(`Missing Proxmox API configuration for node "${node}". Check environment variables.`);
  }
  
  return { url, tokenId, tokenSecret };
}

/**
 * Set Interface VLAN Action
 * 
 * Assigns a VM to an existing VLAN by updating its network configuration.
 * Validates that:
 * 1. VLAN exists in OPNsense
 * 2. VLAN exists in twin (optional, for consistency)
 * 3. VM exists on the specified node
 * 
 * Then updates the VM's network config via Terraform to use the VLAN tag.
 */
export async function setInterfaceVlan(params: SetInterfaceVlanParams): Promise<SetInterfaceVlanResult> {
  const { vmid, node, vlanId, bridge, dryRun } = params;
  const startTime = Date.now();

  // Normalize node name
  let normalizedNode = node;
  const nodeLower = node.toLowerCase();
  if (nodeLower === "yang") {
    normalizedNode = "YANG";
  } else if (nodeLower === "yin") {
    normalizedNode = "yin";
  }

  logger.info("Setting interface VLAN", { vmid, node: normalizedNode, vlanId, bridge, dryRun });

  // 1. Validate VLAN exists in OPNsense (optional - VLANs may be switch-configured)
  // Since vmbr2 has VLAN 50 configured on the switch, it might not be in OPNsense
  let vlanValidatedInOpnsense = false;
  try {
    const opnsenseTool = new OpnsenseReadOnlyTool();
    const vlansResult = await opnsenseTool.execute({
      action: "interfaces_vlans_list",
    }, {} as any);

    const vlansPayload = vlansResult.data as { vlans?: unknown[] } | undefined;
    if (!vlansResult.error && Array.isArray(vlansPayload?.vlans)) {
      const vlans = vlansPayload.vlans as any[];
      const vlanExists = vlans.some((v: any) => {
        // OPNsense VLAN format: vlan_id might be in different fields
        const vid = v.tag || v.vlan_id || v.id || v.vlan;
        return vid === vlanId || vid === vlanId.toString();
      });

      if (vlanExists) {
        vlanValidatedInOpnsense = true;
        logger.info("VLAN validated in OPNsense", { vlanId, availableVlans: vlans.length });
      } else {
        logger.info("VLAN not found in OPNsense (may be switch-configured)", { vlanId });
      }
    }
  } catch (error: any) {
    logger.info("Could not query VLANs from OPNsense (VLAN may be switch-configured)", { 
      error: error.message, 
      vlanId,
      note: "Continuing with bridge-based assignment - VLAN is configured on switch"
    });
    // Don't fail - VLANs configured on switches won't appear in OPNsense
  }

  // 2. Validate VLAN exists in twin (optional, for consistency)
  // Skip twin validation for now - it's optional and requires proper initialization
  // Twin validation can be added later if needed
  logger.info("Skipping twin validation (optional)", { vlanId, note: "VLAN validation relies on bridge configuration" });

  // 3. Validate VM exists on the specified node
  try {
    const proxmoxConfig = getProxmoxClientConfig(normalizedNode);
    const proxmoxClient = new ProxmoxClient({
      url: proxmoxConfig.url,
      tokenId: proxmoxConfig.tokenId,
      tokenSecret: proxmoxConfig.tokenSecret,
      verifySsl: process.env.PROXMOX_VERIFY_SSL !== "false",
    });

    // Get VM info to verify it exists
    try {
      const vmResult = await proxmoxClient.get(`nodes/${normalizedNode}/qemu/${vmid}/status/current`);
      const vmInfo = vmResult.data.data;
      
      if (!vmInfo) {
        return {
          success: false,
          message: `VM ${vmid} not found on node "${normalizedNode}"`,
        };
      }

      logger.info("VM validated", { vmid, node: normalizedNode, vmName: vmInfo.name || `VM ${vmid}` });
    } catch (error: any) {
      if (error.response?.status === 404) {
        return {
          success: false,
          message: `VM ${vmid} not found on node "${normalizedNode}"`,
        };
      }
      throw error;
    }
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to validate VM: ${error.message}`,
    };
  }

  // 4. Update VM network config via Proxmox API
  // Since vmbr2 already has VLAN 50 configured on the switch, we just need to:
  // - Change the bridge from vmbr0 to vmbr2 (or add VLAN tag if using vmbr0 with trunking)
  // 
  // For simplicity, we'll use the bridge approach (vmbr2) since that's what the user has configured.
  // If VLAN tagging is needed (vmbr0 with tag), we can add that later.

  if (dryRun) {
    return {
      success: true,
      message: `Dry-run: Would assign VM ${vmid} on node "${normalizedNode}" to VLAN ${vlanId} using bridge ${bridge}`,
      vmid,
      vlanId,
      bridge,
    };
  }

  try {
    const proxmoxConfig = getProxmoxClientConfig(normalizedNode);
    const proxmoxClient = new ProxmoxClient({
      url: proxmoxConfig.url,
      tokenId: proxmoxConfig.tokenId,
      tokenSecret: proxmoxConfig.tokenSecret,
      verifySsl: process.env.PROXMOX_VERIFY_SSL !== "false",
    });

    // Get current VM config to find the network interface
    const configResult = await proxmoxClient.get(`nodes/${normalizedNode}/qemu/${vmid}/config`);
    const vmConfig = configResult.data.data || {};
    
    // Find the first network interface (usually net0)
    // Proxmox network interfaces are named net0, net1, etc.
    let networkInterface = "net0";
    const networkKeys = Object.keys(vmConfig).filter(key => key.startsWith("net"));
    const firstNetworkKey = networkKeys[0];
    if (firstNetworkKey) {
      networkInterface = firstNetworkKey; // Use the first network interface
    }

    // Build network config string
    // Format: model=virtio,bridge=vmbr2,tag=50 (if VLAN tag needed)
    // For vmbr2 with pre-configured VLAN, just: model=virtio,bridge=vmbr2
    let networkConfig = `model=virtio,bridge=${bridge}`;
    
    // If using vmbr0 (trunk), add VLAN tag
    // If using vmbr2 (pre-configured), VLAN is already on the bridge
    if (bridge === "vmbr0" || bridge === "vmbr1") {
      networkConfig += `,tag=${vlanId}`;
    }
    // For vmbr2, VLAN is already configured on the switch, so no tag needed

    // Update VM config
    logger.info("Updating VM network config", { 
      vmid, 
      node: normalizedNode, 
      interface: networkInterface,
      config: networkConfig 
    });

    const updateResult = await proxmoxClient.put(
      `nodes/${normalizedNode}/qemu/${vmid}/config`,
      {
        [networkInterface]: networkConfig,
      }
    );

    if (!updateResult || (updateResult.data as any).errors) {
      const errorMsg = (updateResult.data as any)?.errors?.[0] || "Unknown error";
      return {
        success: false,
        message: `Failed to update VM network config: ${errorMsg}`,
        vmid,
        vlanId,
        bridge,
      };
    }

    logger.info("VM network config updated successfully", { 
      vmid, 
      node: normalizedNode, 
      vlanId, 
      bridge 
    });

    // Note: VM may need to be restarted for network changes to take effect
    // But we won't auto-restart - let the user decide

    return {
      success: true,
      message: `VM ${vmid} on node "${normalizedNode}" assigned to VLAN ${vlanId} using bridge ${bridge}. Network interface ${networkInterface} updated. Note: VM may need to be restarted for changes to take effect.`,
      vmid,
      vlanId,
      bridge,
    };
  } catch (error: any) {
    logger.error("Failed to update VM network config", { 
      error: error.message, 
      vmid, 
      node: normalizedNode,
      stack: error.stack 
    });
    return {
      success: false,
      message: `Failed to update VM network config: ${error.message}`,
      vmid,
      vlanId,
      bridge,
    };
  }
}
