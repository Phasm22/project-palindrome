import { BaseTool } from "../BaseTool";
import { createToolSchema } from "../tool-helpers";
import { actionRegistry } from "../../actions/registry";
import { ConfigureFirewallSchema } from "../../actions/services/configure-firewall";
import { emitToolProgress } from "../../agent/event-bus";
import { pceLogger as logger } from "../../pce/utils/logger";
import type { ToolSchema } from "../tool-schema";
import type { ExecutionContext, ExecutionResult } from "../../types/execution";

export class ConfigureFirewallTool extends BaseTool {
  constructor() {
    super({
      name: "action_configure_firewall",
      description:
        "Configure UFW (Uncomplicated Firewall) rules on a VM using Ansible. " +
        "Specify port rules and a default policy (allow/deny). " +
        "Set dryRun=true to preview without applying.",
      categories: ["action", "services", "ansible", "firewall", "ufw"],
      allowedAcls: ["admin"],
      risk: "high",
      requiresConfirmation: false,
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, ConfigureFirewallSchema, {
      examples: [
        {
          description: "Open ports 80 and 443, deny everything else",
          parameters: {
            vmName: "my-vm",
            rules: [
              { port: 80, protocol: "tcp", action: "allow" },
              { port: 443, protocol: "tcp", action: "allow" },
            ],
            defaultPolicy: "deny",
            dryRun: false,
          },
        },
        {
          description: "Preview firewall configuration",
          parameters: {
            vmName: "my-vm",
            rules: [{ port: 22, protocol: "tcp", action: "allow" }],
            defaultPolicy: "deny",
            dryRun: true,
          },
        },
      ],
      notes: [
        "vmName (string) is required — use the exact VM hostname",
        "rules is optional — omit to only set the default policy",
        "defaultPolicy defaults to 'deny'",
        "protocol options: 'tcp' | 'udp' | 'both'",
        "Set dryRun: true to preview without executing Ansible",
      ],
    });
  }

  override getParameterSchema() {
    return ConfigureFirewallSchema;
  }

  async execute(params: Record<string, any>, _context: ExecutionContext): Promise<ExecutionResult> {
    const started = Date.now();
    const parsed = ConfigureFirewallSchema.safeParse(params);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}`, durationMs: Date.now() - started };
    }

    const actionDef = actionRegistry.get("services.configure_firewall")!;
    emitToolProgress({ toolName: "action_configure_firewall", action: "services.configure_firewall", status: "starting", message: "Preparing firewall configuration...", progress: 0.1, details: { params: parsed.data } });
    emitToolProgress({ toolName: "action_configure_firewall", action: "services.configure_firewall", status: "running", message: "Configuring UFW via Ansible...", progress: 0.3, details: { step: "ansible" } });

    try {
      const result = await actionDef.execute(parsed.data);
      emitToolProgress({ toolName: "action_configure_firewall", action: "services.configure_firewall", status: "completed", message: "Firewall configuration completed successfully", progress: 1, details: { result } });
      return { data: result, durationMs: Date.now() - started };
    } catch (error: any) {
      logger.error("action_configure_firewall failed", { error: error.message });
      emitToolProgress({ toolName: "action_configure_firewall", action: "services.configure_firewall", status: "failed", message: `Action failed: ${error.message}`, progress: 0, details: { error: error.message } });
      return { error: error.message || "Action execution failed", durationMs: Date.now() - started };
    }
  }
}
