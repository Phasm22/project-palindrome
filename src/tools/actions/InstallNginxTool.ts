import { BaseTool } from "../BaseTool";
import { createToolSchema } from "../tool-helpers";
import { actionRegistry } from "../../actions/registry";
import { InstallNginxSchema } from "../../actions/services/install-nginx";
import { emitToolProgress } from "../../agent/event-bus";
import { pceLogger as logger } from "../../pce/utils/logger";
import type { ToolSchema } from "../tool-schema";
import type { ExecutionContext, ExecutionResult } from "../../types/execution";

export class InstallNginxTool extends BaseTool {
  constructor() {
    super({
      name: "action_install_nginx",
      description:
        "Install and configure nginx web server on a VM using Ansible. " +
        "Set waitForVm=true to wait for SSH accessibility before running. " +
        "Set dryRun=true to preview without executing.",
      categories: ["action", "services", "ansible", "nginx"],
      allowedAcls: ["admin", "ops"],
      risk: "medium",
      requiresConfirmation: false,
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, InstallNginxSchema, {
      examples: [
        {
          description: "Install nginx on a VM",
          parameters: { vmName: "my-vm", waitForVm: true, timeout: 300, dryRun: false },
        },
      ],
      notes: [
        "vmName (string) is required — use the exact VM hostname",
        "Installs and configures nginx web server",
        "Set dryRun: true to preview without executing Ansible",
      ],
    });
  }

  override getParameterSchema() {
    return InstallNginxSchema;
  }

  async execute(params: Record<string, any>, _context: ExecutionContext): Promise<ExecutionResult> {
    const started = Date.now();
    const parsed = InstallNginxSchema.safeParse(params);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}`, durationMs: Date.now() - started };
    }

    const actionDef = actionRegistry.get("services.install_nginx")!;
    emitToolProgress({ toolName: "action_install_nginx", action: "services.install_nginx", status: "starting", message: "Preparing nginx installation...", progress: 0.1, details: { params: parsed.data } });
    emitToolProgress({ toolName: "action_install_nginx", action: "services.install_nginx", status: "running", message: "Installing nginx via Ansible...", progress: 0.3, details: { step: "ansible" } });

    try {
      const result = await actionDef.execute(parsed.data);
      emitToolProgress({ toolName: "action_install_nginx", action: "services.install_nginx", status: "completed", message: "nginx installation completed successfully", progress: 1, details: { result } });
      return { data: result, durationMs: Date.now() - started };
    } catch (error: any) {
      logger.error("action_install_nginx failed", { error: error.message });
      emitToolProgress({ toolName: "action_install_nginx", action: "services.install_nginx", status: "failed", message: `Action failed: ${error.message}`, progress: 0, details: { error: error.message } });
      return { error: error.message || "Action execution failed", durationMs: Date.now() - started };
    }
  }
}
