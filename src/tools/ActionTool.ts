import { z } from "zod";
import { BaseTool } from "./BaseTool";
import { actionRegistry } from "../actions/registry";
import { pceLogger as logger } from "../pce/utils/logger";
import type { ExecutionContext, ExecutionResult } from "../types/execution";
import type { ToolSchema } from "./tool-schema";
import { createToolSchema } from "./tool-helpers";
import { emitToolProgress } from "../agent/event-bus";

// Use z.any() wrapped in z.object() instead of z.record() to avoid schema issues
const ActionParams = z.object({
  action: z.string().describe("Action name (e.g., 'compute.create_vm')"),
  params: z.any().describe(
    "Action parameters as an object. " +
        "For compute.create_vm: {name?: string, node: string, cores?: number, memory?: number, diskSize?: string, vmBridge?: string (default: 'vmbr0'), vlanId?: number (1-4094, optional), datastore?: string, templateId?: number, bootstrap?: boolean, dryRun?: boolean}. If name is not provided, a palindrome name will be auto-generated. Node names are canonicalized to live Proxmox values when possible. If vmBridge/datastore/templateId are omitted or unavailable, the action selects from available options on the target node and reports any fallback. Set vmBridge to 'vmbr2' for pre-configured VLAN bridges, or use vlanId with vmbr0 for VLAN tagging. Set bootstrap=true to run Ansible bootstrap after VM creation. " +
        "For compute.destroy_vm: {name?: string, vmId?: number, node?: string, dryRun?: boolean}. Either name or vmId is required. " +
        "For network.create_dns_record: {hostname: string, ip: string, domain?: string, dryRun?: boolean}. Creates DNS A record in Pi-hole. " +
        "For network.sync_dhcp_to_dns: {dryRun?: boolean, domain?: string, updateExisting?: boolean}. Syncs OPNsense DHCP leases to Pi-hole DNS records. " +
        "For services.bootstrap: {vmName: string, playbook?: string, waitForVm?: boolean, timeout?: number, retryOnFailure?: boolean, maxRetries?: number, dryRun?: boolean}. Runs Ansible playbook (default: common.yml) on a VM. " +
        "For services.install_docker: {vmName: string, waitForVm?: boolean, timeout?: number, retryOnFailure?: boolean, maxRetries?: number, dryRun?: boolean}. Installs Docker CE, Docker Compose, and Portainer on a VM. " +
        "For services.install_nginx: {vmName: string, waitForVm?: boolean, timeout?: number, retryOnFailure?: boolean, maxRetries?: number, dryRun?: boolean}. Installs and configures nginx web server on a VM. " +
        "For services.configure_firewall: {vmName: string, rules?: Array<{port: number, protocol?: 'tcp'|'udp'|'both', action?: 'allow'|'deny'}>, defaultPolicy?: 'allow'|'deny', waitForVm?: boolean, timeout?: number, retryOnFailure?: boolean, maxRetries?: number, dryRun?: boolean}. Configures UFW firewall rules on a VM. " +
        "For services.set_static_ip: {vmName: string, ip: string (CIDR format, e.g., '192.168.1.100/24'), gateway: string, dns?: string[], interface?: string (default: 'eth0'), waitForVm?: boolean, timeout?: number, retryOnFailure?: boolean, maxRetries?: number, dryRun?: boolean}. Configures a static IP address on a VM using netplan. " +
    "templateId is the VM template ID to clone from (optional). If omitted, the action discovers available templates on the target node and selects the best match. " +
    "Must be an object."
  ),
});

/**
 * Action Tool
 * 
 * Exposes Action Layer operations to the LLM.
 * Actions are safe, deterministic operations that use Terraform/Ansible.
 */
export class ActionTool extends BaseTool {
  constructor() {
    super({
      name: "action",
      description: "Execute safe automation actions (create VMs, configure network, manage firewall). Uses Terraform/Ansible for deterministic operations.",
      categories: ["action", "automation", "terraform", "ansible"],
      allowedAcls: ["admin", "ops"],
      risk: "medium", // Actions modify infrastructure but are safe and deterministic
      requiresConfirmation: false, // No HITL approval needed - actions are safe and deterministic
    });
  }

  override getSchema(): ToolSchema {
    const availableActions = actionRegistry.list();
    const actionExamples = availableActions.map(a => ({
      description: a.description,
      parameters: {
        action: a.name,
        params: {} // Placeholder - actual params depend on action
      }
    }));

    return createToolSchema(this, ActionParams, {
      examples: [
        {
          description: "Create a new VM on a Proxmox node",
          parameters: {
            action: "compute.create_vm",
            params: {
              name: "test-vm",
              node: "proxBig",
              cores: 2,
              memory: 4096,
              diskSize: "20G",
              dryRun: false
            }
          }
        },
        {
          description: "Create a VM with a specific template ID",
          parameters: {
            action: "compute.create_vm",
            params: {
              name: "test-vm",
              node: "yin",
              cores: 2,
              memory: 4096,
              diskSize: "20G",
              templateId: 104,
              dryRun: false
            }
          }
        },
        {
          description: "Create a VM without specifying a name (palindrome will be auto-generated)",
          parameters: {
            action: "compute.create_vm",
            params: {
              node: "YANG",
              cores: 2,
              memory: 4096,
              diskSize: "20G",
              dryRun: false
            }
          }
        },
        {
          description: "Create a VM in VLAN 50 using pre-configured bridge vmbr2",
          parameters: {
            action: "compute.create_vm",
            params: {
              node: "YANG",
              vmBridge: "vmbr2",
              vlanId: 50,
              cores: 2,
              memory: 4096,
              diskSize: "20G",
              dryRun: false
            }
          }
        },
        {
          description: "Create a VM with automatic bootstrap (runs Ansible common.yml after creation)",
          parameters: {
            action: "compute.create_vm",
            params: {
              node: "YANG",
              cores: 2,
              memory: 4096,
              diskSize: "20G",
              bootstrap: true,
              dryRun: false
            }
          }
        },
        {
          description: "Bootstrap a VM (run Ansible common.yml playbook)",
          parameters: {
            action: "services.bootstrap",
            params: {
              vmName: "dad",
              waitForVm: true,
              timeout: 300,
              dryRun: false
            }
          }
        },
        {
          description: "Install Docker on a VM",
          parameters: {
            action: "services.install_docker",
            params: {
              vmName: "dad",
              waitForVm: true,
              timeout: 300,
              dryRun: false
            }
          }
        },
        {
          description: "Install nginx on a VM",
          parameters: {
            action: "services.install_nginx",
            params: {
              vmName: "dad",
              waitForVm: true,
              timeout: 300,
              dryRun: false
            }
          }
        },
        {
          description: "Configure firewall rules on a VM",
          parameters: {
            action: "services.configure_firewall",
            params: {
              vmName: "dad",
              rules: [
                { port: 80, protocol: "tcp", action: "allow" },
                { port: 443, protocol: "tcp", action: "allow" }
              ],
              defaultPolicy: "deny",
              dryRun: false
            }
          }
        },
        {
          description: "Set static IP address on a VM",
          parameters: {
            action: "services.set_static_ip",
            params: {
              vmName: "dad",
              ip: "192.168.1.100/24",
              gateway: "192.168.1.1",
              dns: ["8.8.8.8", "8.8.4.4"],
              interface: "eth0",
              dryRun: false
            }
          }
        },
        ...actionExamples.slice(0, 2) // Include first 2 other actions as examples
      ],
      notes: [
        "Available actions: " + availableActions.map(a => a.name).join(", "),
        "For VM creation, use action: 'compute.create_vm'",
        "For VM destruction, use action: 'compute.destroy_vm'",
        "Actions use Terraform/Ansible for safe, deterministic operations",
        "Set dryRun: true to preview changes without applying them",
        "For compute.create_vm: node/datastore/vmBridge/templateId are availability-aware. The action canonicalizes node names and auto-selects from discovered options on that node, with explicit fallback warnings.",
        "For compute.destroy_vm: name (string, optional) - VM name to destroy. vmId (number, optional) - VM ID to destroy. Either name or vmId is required. node (string, optional) - Node name for validation. dryRun (boolean, optional) - Preview destruction without executing.",
        "For network.create_dns_record: hostname (string, required) - Hostname (e.g., 'web-server'). ip (string, required) - IPv4 address (e.g., '172.16.50.100'). domain (string, optional, default: '.prox') - Domain suffix to append. dryRun (boolean, optional) - Preview DNS record creation without executing.",
        "For network.sync_dhcp_to_dns: dryRun (boolean, optional) - Preview sync without creating/updating DNS records. domain (string, optional, default: '.prox') - Domain suffix for DNS records. updateExisting (boolean, optional, default: true) - Update DNS records if IP changed. This action queries OPNsense DHCP leases and creates/updates corresponding DNS records in Pi-hole, bridging the gap between OPNsense DHCP (Unbound) and Pi-hole (forwarder)."
      ]
    });
  }

  override getParameterSchema() {
    return ActionParams;
  }

  async execute(
    params: Record<string, any>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const started = Date.now();
    
    // Normalize params - handle case where LLM sends params as a string
    const normalizedParams = { ...params };
    if (typeof normalizedParams.params === "string") {
      try {
        normalizedParams.params = JSON.parse(normalizedParams.params);
      } catch (e) {
        return {
          error: `Invalid params format: expected object, got string that couldn't be parsed as JSON: ${normalizedParams.params}`,
          durationMs: Date.now() - started,
        };
      }
    }
    
    // Also handle case where action params are at top level (flatten them)
    if (!normalizedParams.params && normalizedParams.action) {
      // Extract action-specific params from top level
      const { action, ...rest } = normalizedParams;
      normalizedParams.params = rest;
    }

    const parsed = ActionParams.safeParse(normalizedParams);
    if (!parsed.success) {
      return {
        error: `Invalid parameters: ${parsed.error.message}`,
        durationMs: Date.now() - started,
      };
    }

    const { action, params: actionParams } = parsed.data;

    try {
      // Get action from registry
      const actionDef = actionRegistry.get(action);
      if (!actionDef) {
        const availableActions = actionRegistry.list().map(a => a.name).join(", ");
        return {
          error: `Action "${action}" not found. Available actions: ${availableActions}`,
          durationMs: Date.now() - started,
        };
      }

      // Validate parameters
      const validatedParams = actionDef.schema.parse(actionParams);

      logger.info("Executing action", { action, params: validatedParams });

      // Emit progress: starting
      emitToolProgress({
        toolName: "action",
        action,
        status: "starting",
        message: `Preparing to execute ${action}...`,
        progress: 0.1,
        details: { params: validatedParams },
      });

      // Emit progress: running
      const actionFriendlyName = action.replace(/\./g, ' → ').replace(/_/g, ' ');
      emitToolProgress({
        toolName: "action",
        action,
        status: "running",
        message: `Executing ${actionFriendlyName}...`,
        progress: 0.3,
        details: { step: "terraform/ansible" },
      });

      // Execute action
      const result = await actionDef.execute(validatedParams);

      // Emit progress: completed
      emitToolProgress({
        toolName: "action",
        action,
        status: "completed",
        message: `${actionFriendlyName} completed successfully`,
        progress: 1,
        details: { result: typeof result === 'object' ? result : { value: result } },
      });

      return {
        data: result,
        durationMs: Date.now() - started,
      };
    } catch (error: any) {
      logger.error("Action execution failed", { action, error: error.message });
      
      // Emit progress: failed
      emitToolProgress({
        toolName: "action",
        action,
        status: "failed",
        message: `Action failed: ${error.message}`,
        progress: 0,
        details: { error: error.message },
      });
      
      return {
        error: error.message || "Action execution failed",
        durationMs: Date.now() - started,
      };
    }
  }
}
