import { BaseTool } from "../BaseTool";
import { createToolSchema } from "../tool-helpers";
import { actionRegistry } from "../../actions/registry";
import { SetStaticIpSchema } from "../../actions/services/set-static-ip";
import { emitToolProgress } from "../../agent/event-bus";
import { pceLogger as logger } from "../../pce/utils/logger";
import type { ToolSchema } from "../tool-schema";
import type { ExecutionContext, ExecutionResult } from "../../types/execution";

export class SetStaticIpTool extends BaseTool {
  constructor() {
    super({
      name: "action_set_static_ip",
      description:
        "Configure a static IP address on a VM using netplan via Ansible. " +
        "IP must be in CIDR format (e.g., '192.168.1.100/24'). " +
        "Set dryRun=true to preview without applying.",
      categories: ["action", "services", "ansible", "network", "ip"],
      allowedAcls: ["admin"],
      risk: "high",
      requiresConfirmation: false,
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, SetStaticIpSchema, {
      examples: [
        {
          description: "Set static IP on a VM",
          parameters: {
            vmName: "my-vm",
            ip: "192.168.1.100/24",
            gateway: "192.168.1.1",
            dns: ["8.8.8.8", "8.8.4.4"],
            interface: "eth0",
            dryRun: false,
          },
        },
        {
          description: "Preview static IP configuration",
          parameters: {
            vmName: "my-vm",
            ip: "172.16.50.100/24",
            gateway: "172.16.50.1",
            dryRun: true,
          },
        },
      ],
      notes: [
        "vmName (string) is required — use the exact VM hostname",
        "ip must be in CIDR format: '192.168.1.100/24'",
        "gateway must be a valid IPv4 address",
        "dns defaults to ['8.8.8.8', '8.8.4.4']",
        "interface defaults to 'eth0'",
        "Set dryRun: true to preview without executing Ansible",
      ],
    });
  }

  override getParameterSchema() {
    return SetStaticIpSchema;
  }

  async execute(params: Record<string, any>, _context: ExecutionContext): Promise<ExecutionResult> {
    const started = Date.now();
    const parsed = SetStaticIpSchema.safeParse(params);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}`, durationMs: Date.now() - started };
    }

    const actionDef = actionRegistry.get("services.set_static_ip")!;
    emitToolProgress({ toolName: "action_set_static_ip", action: "services.set_static_ip", status: "starting", message: "Preparing static IP configuration...", progress: 0.1, details: { params: parsed.data } });
    emitToolProgress({ toolName: "action_set_static_ip", action: "services.set_static_ip", status: "running", message: "Configuring static IP via Ansible...", progress: 0.3, details: { step: "ansible" } });

    try {
      const result = await actionDef.execute(parsed.data);
      emitToolProgress({ toolName: "action_set_static_ip", action: "services.set_static_ip", status: "completed", message: "Static IP configuration completed successfully", progress: 1, details: { result } });
      return { data: result, durationMs: Date.now() - started };
    } catch (error: any) {
      logger.error("action_set_static_ip failed", { error: error.message });
      emitToolProgress({ toolName: "action_set_static_ip", action: "services.set_static_ip", status: "failed", message: `Action failed: ${error.message}`, progress: 0, details: { error: error.message } });
      return { error: error.message || "Action execution failed", durationMs: Date.now() - started };
    }
  }
}
