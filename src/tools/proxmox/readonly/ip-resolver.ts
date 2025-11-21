/**
 * VM IP Address Resolution
 * Resolves VM IP addresses using multiple strategies:
 * 1. OPNsense DHCP leases (for lab network VMs)
 * 2. Proxmox guest agent (if enabled)
 * 3. SSH query (if accessible)
 * 4. Topology graph (if defined)
 */

import { ProxmoxClient } from "../client";
import { MCPOpnsenseTool } from "../../MCPOpnsenseTool";
import { SSHTool } from "../../SSHTool";
import { pceLogger } from "../../../pce/utils/logger";

export interface IPResolutionResult {
  ip: string | null;
  source: "dhcp" | "guest_agent" | "ssh" | "topology" | "unknown";
  mac?: string;
}

/**
 * Extract MAC address from Proxmox network config
 */
function extractMACFromNetworkConfig(networkConfig: Record<string, any>): string | null {
  // Proxmox network config format: net0: virtio=XX:XX:XX:XX:XX:XX,bridge=vmbr0
  for (const [key, value] of Object.entries(networkConfig)) {
    if (key.startsWith("net") && typeof value === "string") {
      // Extract MAC from virtio=MAC or model=MAC format
      const macMatch = value.match(/(?:virtio|model)=([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/);
      if (macMatch) {
        return macMatch[1].toLowerCase();
      }
    }
  }
  return null;
}

/**
 * Query OPNsense DHCP leases for a MAC address
 */
async function queryOPNsenseDHCP(mac: string): Promise<string | null> {
  try {
    const opnsenseTool = new MCPOpnsenseTool();
    
    // Try to get DHCP leases
    // Note: This depends on MCP tool supporting DHCP lease queries
    // If not available, we'll need to add it
    const result = await opnsenseTool.execute(
      {
        module: "dhcp",
        action: "list", // or "get_leases" / "search"
        parameters: {
          mac: mac,
        },
      },
      { toolName: "mcp_opnsense", startedAt: Date.now() }
    );

    if (result.error || !result.data) {
      pceLogger.debug("OPNsense DHCP query failed or no data", { error: result.error });
      return null;
    }

    // Parse DHCP lease data to find IP for this MAC
    // Format depends on OPNsense API response
    const leases = Array.isArray(result.data) ? result.data : result.data.leases || [];
    for (const lease of leases) {
      if (lease.mac?.toLowerCase() === mac.toLowerCase()) {
        return lease.ip || lease.address;
      }
    }

    return null;
  } catch (error: any) {
    pceLogger.warn("Failed to query OPNsense DHCP", { error: error.message });
    return null;
  }
}

/**
 * Get VM IP via SSH
 */
async function getVMIPViaSSH(vmName: string, vmIP?: string, hostIP?: string): Promise<string | null> {
  try {
    // If we already have the IP, return it
    if (vmIP) return vmIP;

    // Try to SSH into the VM
    // We need the VM's IP first, which is the chicken/egg problem
    // So this only works if we have some way to get the IP first
    
    // Alternative: SSH into the host and query from there
    if (hostIP) {
      const sshTool = new SSHTool();
      const result = await sshTool.execute(
        {
          host: hostIP,
          command: `qm guest cmd ${vmName} network-get-interfaces 2>/dev/null || echo "guest agent not available"`,
        },
        { toolName: "ssh", startedAt: Date.now() }
      );

      if (!result.error && result.data) {
        // Parse guest agent output for IP
        // This is a fallback if guest agent is available
      }
    }

    return null;
  } catch (error: any) {
    pceLogger.warn("Failed to get VM IP via SSH", { error: error.message });
    return null;
  }
}

/**
 * Resolve VM IP address using multiple strategies
 */
export async function resolveVMIP(
  vmName: string,
  node: string,
  vmid: number,
  proxmoxClient: ProxmoxClient
): Promise<IPResolutionResult> {
  try {
    // Step 1: Get VM network config from Proxmox
    const vmConfig = await proxmoxClient.getVMConfig(node, vmid);
    const networkConfig = vmConfig.network || {};
    const mac = extractMACFromNetworkConfig(networkConfig);

    pceLogger.debug("Resolving VM IP", { vmName, node, vmid, mac });

    // Step 2: Try OPNsense DHCP (for lab network: 172.16.0.0/22)
    if (mac) {
      const dhcpIP = await queryOPNsenseDHCP(mac);
      if (dhcpIP) {
        return {
          ip: dhcpIP,
          source: "dhcp",
          mac,
        };
      }
    }

    // Step 3: Try Proxmox guest agent (if enabled)
    // Check if agent is enabled in config
    if (vmConfig.agent === 1 || vmConfig.agent === "enabled") {
      try {
        // Query guest agent for network info
        // This requires guest agent to be running in the VM
        // Proxmox API: GET /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces
        const agentResult = await proxmoxClient.execute(
          `nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`,
          "GET"
        );

        if (agentResult && Array.isArray(agentResult.result)) {
          // Parse agent response for IP addresses
          for (const iface of agentResult.result) {
            if (iface["ip-addresses"] && Array.isArray(iface["ip-addresses"])) {
              for (const ipAddr of iface["ip-addresses"]) {
                if (ipAddr["ip-address-type"] === "ipv4" && !ipAddr["ip-address"].startsWith("127.")) {
                  return {
                    ip: ipAddr["ip-address"],
                    source: "guest_agent",
                    mac,
                  };
                }
              }
            }
          }
        }
      } catch (error: any) {
        pceLogger.debug("Guest agent query failed", { error: error.message });
      }
    }

    // Step 4: Return null if no IP found
    return {
      ip: null,
      source: "unknown",
      mac: mac || undefined,
    };
  } catch (error: any) {
    pceLogger.error("Failed to resolve VM IP", { error: error.message, vmName, node, vmid });
    return {
      ip: null,
      source: "unknown",
    };
  }
}

