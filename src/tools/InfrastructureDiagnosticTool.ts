import { z } from "zod";
import { BaseTool } from "./BaseTool";
import { createToolSchema } from "./tool-helpers";
import type { ExecutionContext, ExecutionResult } from "../types/execution";
import type { ToolSchema } from "./tool-schema";
import { ProxmoxClient } from "./proxmox/client";
import { pceLogger as logger } from "../pce/utils/logger";

/**
 * Infrastructure Diagnostic Tool
 * 
 * Provides diagnostic capabilities for infrastructure components:
 * - Guest agent status checks
 * - Network connectivity diagnostics
 * - Service health checks
 * - Configuration validation
 */

const DiagnosticParams = z.object({
  diagnostic_type: z.enum([
    "guest_agent",
    "network_connectivity",
    "service_health",
    "vm_health",
  ]).describe("Type of diagnostic to run"),
  vmid: z.number().int().positive().optional().describe("VM ID (required for guest_agent, vm_health)"),
  node: z.string().optional().describe("Proxmox node name (required for guest_agent, vm_health)"),
  hostname: z.string().optional().describe("Hostname or IP to check (for network_connectivity)"),
  service: z.string().optional().describe("Service name to check (for service_health)"),
});

type DiagnosticParams = z.infer<typeof DiagnosticParams>;

interface GuestAgentStatus {
  vmid: number;
  node: string;
  vmName: string;
  config: {
    agentEnabled: boolean;
    agentValue: any;
  };
  package: {
    installed: boolean;
    error?: string;
  };
  service: {
    running: boolean;
    enabled: boolean;
    error?: string;
  };
  api: {
    reachable: boolean;
    error?: string;
    response?: any;
  };
  summary: string;
  recommendations: string[];
}

export class InfrastructureDiagnosticTool extends BaseTool {
  constructor() {
    super({
      name: "infrastructure_diagnostic",
      description: "Run diagnostic checks on infrastructure components (guest agent, network, services, VMs). Use this to troubleshoot issues automatically.",
      categories: ["diagnostic", "troubleshooting", "infrastructure"],
      allowedAcls: ["admin", "ops"],
      risk: "low", // Read-only diagnostic operations
      requiresConfirmation: false,
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, DiagnosticParams, {
      examples: [
        {
          description: "Check guest agent status for a VM",
          parameters: {
            diagnostic_type: "guest_agent",
            vmid: 9000,
            node: "YANG",
          },
        },
        {
          description: "Check VM health and configuration",
          parameters: {
            diagnostic_type: "vm_health",
            vmid: 9000,
            node: "YANG",
          },
        },
        {
          description: "Check network connectivity to a host",
          parameters: {
            diagnostic_type: "network_connectivity",
            hostname: "bob.prox",
          },
        },
      ],
    });
  }

  override async execute(
    params: DiagnosticParams,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const { diagnostic_type, vmid, node, hostname, service } = params;

    try {
      switch (diagnostic_type) {
        case "guest_agent":
          if (!vmid || !node) {
            return { error: "vmid and node are required for guest_agent diagnostic" };
          }
          return await this.checkGuestAgent(vmid, node);

        case "vm_health":
          if (!vmid || !node) {
            return { error: "vmid and node are required for vm_health diagnostic" };
          }
          return await this.checkVmHealth(vmid, node);

        case "network_connectivity":
          if (!hostname) {
            return { error: "hostname is required for network_connectivity diagnostic" };
          }
          return await this.checkNetworkConnectivity(hostname);

        case "service_health":
          if (!service) {
            return { error: "service is required for service_health diagnostic" };
          }
          return await this.checkServiceHealth(service);

        default:
          return { error: `Unknown diagnostic type: ${diagnostic_type}` };
      }
    } catch (error: any) {
      logger.error("Diagnostic tool error", { diagnostic_type, error: error.message, stack: error.stack });
      return { error: `Diagnostic failed: ${error.message}` };
    }
  }

  private async checkGuestAgent(vmid: number, node: string): Promise<ExecutionResult> {
    try {
      // Normalize node name
      let normalizedNode = node.toUpperCase();
      if (normalizedNode === "YANG" || normalizedNode === "YIN") {
        normalizedNode = normalizedNode === "YANG" ? "YANG" : "yin";
      } else if (normalizedNode === "PROXBIG" || normalizedNode === "PROX_BIG") {
        normalizedNode = "proxBig";
      }

      // Get Proxmox client config
      const proxmoxConfig = this.getProxmoxClientConfig(normalizedNode);
      const proxmoxClient = new ProxmoxClient({
        url: proxmoxConfig.url,
        tokenId: proxmoxConfig.tokenId,
        tokenSecret: proxmoxConfig.tokenSecret,
        verifySsl: process.env.PROXMOX_VERIFY_SSL !== "false",
      });

      // Get VM config
      const vmConfig = await proxmoxClient.get(`/nodes/${normalizedNode}/qemu/${vmid}/config`);
      const vmStatus = await proxmoxClient.get(`/nodes/${normalizedNode}/qemu/${vmid}/status/current`);
      const vmName = vmConfig.data.data.name || `VM ${vmid}`;

      const status: GuestAgentStatus = {
        vmid,
        node: normalizedNode,
        vmName,
        config: {
          agentEnabled: false,
          agentValue: vmConfig.data.data.agent,
        },
        package: {
          installed: false,
        },
        service: {
          running: false,
          enabled: false,
        },
        api: {
          reachable: false,
        },
        summary: "",
        recommendations: [],
      };

      // Check 1: Proxmox config
      const agentValue = vmConfig.data.data.agent;
      status.config.agentEnabled = 
        agentValue === 1 || 
        agentValue === "1" || 
        agentValue === "enabled" ||
        (typeof agentValue === "string" && agentValue.includes("enabled=1"));

      // Check 2: API query
      try {
        const agentResponse = await proxmoxClient.get(
          `/nodes/${normalizedNode}/qemu/${vmid}/agent/network-get-interfaces`
        );
        status.api.reachable = true;
        status.api.response = agentResponse.data.data;
      } catch (error: any) {
        status.api.error = error.message;
        if (error.response) {
          status.api.error = `HTTP ${error.response.status}: ${error.response.statusText || error.message}`;
        }
      }

      // Check 3 & 4: Package and service (only if agent is enabled and reachable)
      if (status.config.agentEnabled && status.api.reachable) {
        try {
          // Check package
          try {
            const packageCheck = await proxmoxClient.post(
              `/nodes/${normalizedNode}/qemu/${vmid}/agent/exec`,
              {
                command: "/usr/bin/dpkg",
                arguments: ["-l", "qemu-guest-agent"],
              }
            );
            const output = packageCheck.data.data?.out || "";
            status.package.installed = output.includes("qemu-guest-agent");
          } catch (error: any) {
            status.package.error = `Cannot check package: ${error.message}`;
          }

          // Check service
          try {
            const serviceStatus = await proxmoxClient.post(
              `/nodes/${normalizedNode}/qemu/${vmid}/agent/exec-status`,
              {
                command: "/usr/bin/systemctl",
                arguments: ["is-active", "qemu-guest-agent.service"],
              }
            );
            const output = serviceStatus.data.data?.out || "";
            status.service.running = output.trim() === "active";

            const serviceEnabled = await proxmoxClient.post(
              `/nodes/${normalizedNode}/qemu/${vmid}/agent/exec-status`,
              {
                command: "/usr/bin/systemctl",
                arguments: ["is-enabled", "qemu-guest-agent.service"],
              }
            );
            const enabledOutput = serviceEnabled.data.data?.out || "";
            status.service.enabled = enabledOutput.trim() === "enabled";
          } catch (error: any) {
            status.service.error = `Cannot check service: ${error.message}`;
          }
        } catch (error: any) {
          status.package.error = error.message;
          status.service.error = error.message;
        }
      } else {
        status.package.error = "Cannot check package/service: guest agent not enabled or not reachable";
        status.service.error = "Cannot check package/service: guest agent not enabled or not reachable";
      }

      // Generate summary and recommendations
      const allGood = 
        status.config.agentEnabled &&
        status.package.installed &&
        status.service.running &&
        status.service.enabled &&
        status.api.reachable;

      if (allGood) {
        status.summary = "✅ Guest agent is fully operational";
      } else {
        status.summary = "⚠️ Guest agent has issues";
        if (!status.config.agentEnabled) {
          status.recommendations.push(`Run: qm set ${vmid} --agent enabled=1`);
        }
        if (!status.package.installed && !status.package.error) {
          status.recommendations.push(`SSH into VM and run: apt install qemu-guest-agent`);
        }
        if (!status.service.running && !status.service.error) {
          status.recommendations.push(`SSH into VM and run: systemctl start qemu-guest-agent`);
        }
        if (!status.service.enabled && !status.service.error) {
          status.recommendations.push(`SSH into VM and run: systemctl enable qemu-guest-agent`);
        }
        if (!status.api.reachable) {
          if (status.api.error?.includes("403")) {
            status.recommendations.push(`Check API token permissions (needs VM.Monitor + VM.Audit)`);
          } else if (status.api.error?.includes("500") || status.api.error?.includes("501")) {
            status.recommendations.push(`Ensure guest agent is running and VM is booted. If cloud-init just finished, wait 1-2 minutes and check again.`);
          }
        }
      }

      return {
        data: {
          success: true,
          diagnostic_type: "guest_agent",
          vmid,
          node: normalizedNode,
          result: status,
        },
      };
    } catch (error: any) {
      logger.error("Guest agent diagnostic failed", { vmid, node, error: error.message });
      return { error: `Guest agent diagnostic failed: ${error.message}` };
    }
  }

  private async checkVmHealth(vmid: number, node: string): Promise<ExecutionResult> {
    // TODO: Implement VM health check (status, resources, connectivity)
    return {
      data: { success: false, diagnostic_type: "vm_health", vmid, node },
      error: "vm_health diagnostic not yet implemented",
    };
  }

  private async checkNetworkConnectivity(hostname: string): Promise<ExecutionResult> {
    // TODO: Implement network connectivity check (ping, DNS, port checks)
    return {
      data: { success: false, diagnostic_type: "network_connectivity", hostname },
      error: "network_connectivity diagnostic not yet implemented",
    };
  }

  private async checkServiceHealth(service: string): Promise<ExecutionResult> {
    // TODO: Implement service health check
    return {
      data: { success: false, diagnostic_type: "service_health", service },
      error: "service_health diagnostic not yet implemented",
    };
  }

  private getProxmoxClientConfig(node: string): { url: string; tokenId: string; tokenSecret: string } {
    const nodeLower = node.toLowerCase();
    
    let url: string;
    let tokenId: string | undefined;
    let tokenSecret: string | undefined;
    
    if (nodeLower === "yin" || nodeLower === "yang") {
      url = nodeLower === "yin"
        ? process.env.PROXMOX_YIN_URL || process.env.PROXMOX_URL || `https://yin.prox:8006`
        : process.env.PROXMOX_YANG_URL || process.env.PROXMOX_URL || `https://YANG.prox:8006`;
      tokenId = process.env.CLUSTER_TF_TOKEN_ID || process.env.PROXMOX_TOKEN_ID;
      if (nodeLower === "yin") {
        tokenSecret = process.env.PROXMOX_YIN_TF_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
      } else {
        tokenSecret = process.env.PROXMOX_YANG_TF_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
      }
    } else {
      url = process.env.PROXMOX_URL || `https://proxBig.prox:8006`;
      tokenId = process.env.CLUSTER_TF_TOKEN_ID || process.env.PROXBIG_TF_TOKEN_ID || process.env.PROXMOX_TOKEN_ID;
      tokenSecret = process.env.PROXMOX_PROXBIG_TF_SECRET || process.env.PROXBIG_TF_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
    }
    
    if (!url || !tokenId || !tokenSecret) {
      throw new Error(`Missing Proxmox API configuration for node "${node}". Check environment variables.`);
    }
    
    return { url, tokenId, tokenSecret };
  }
}
