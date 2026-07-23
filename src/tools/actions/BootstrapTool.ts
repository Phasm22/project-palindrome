import { BaseTool } from "../BaseTool";
import { createToolSchema } from "../tool-helpers";
import { actionRegistry } from "../../actions/registry";
import { BootstrapSchema } from "../../actions/services/bootstrap";
import { emitToolProgress } from "../../agent/event-bus";
import { pceLogger as logger } from "../../pce/utils/logger";
import type { ToolSchema } from "../tool-schema";
import type { ExecutionContext, ExecutionResult } from "../../types/execution";

export class BootstrapTool extends BaseTool {
  constructor() {
    super({
      name: "action_bootstrap",
      description:
        "Run an Ansible bootstrap playbook on a VM to perform initial system setup. " +
        "Default playbook is common.yml (security hardening, Docker, base packages). " +
        "Set waitForVm=true to wait for SSH accessibility before running. " +
        "Set dryRun=true to preview without executing.",
      categories: ["action", "services", "ansible", "bootstrap"],
      allowedAcls: ["admin", "ops"],
      risk: "medium",
      requiresConfirmation: false,
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, BootstrapSchema, {
      examples: [
        {
          description: "Bootstrap a VM with the default common.yml playbook",
          parameters: { vmName: "my-vm", waitForVm: true, timeout: 300, dryRun: false },
        },
        {
          description: "Bootstrap with a custom playbook",
          parameters: { vmName: "my-vm", playbook: "nginx.yml", waitForVm: true, timeout: 300, dryRun: false },
        },
      ],
      notes: [
        "vmName (string) is required — use the exact VM hostname",
        "Default playbook is 'common.yml'",
        "waitForVm: true waits for SSH to become accessible before running Ansible",
        "timeout is SSH wait timeout in seconds (default: 300)",
        "Set dryRun: true to preview without executing Ansible",
      ],
    });
  }

  override getParameterSchema() {
    return BootstrapSchema;
  }

  async execute(params: Record<string, any>, _context: ExecutionContext): Promise<ExecutionResult> {
    const started = Date.now();
    const parsed = BootstrapSchema.safeParse(params);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}`, durationMs: Date.now() - started };
    }

    const actionDef = actionRegistry.get("services.bootstrap")!;
    emitToolProgress({ toolName: "action_bootstrap", action: "services.bootstrap", status: "starting", message: "Preparing Ansible bootstrap...", progress: 0.1, details: { params: parsed.data } });
    emitToolProgress({ toolName: "action_bootstrap", action: "services.bootstrap", status: "running", message: `Running Ansible ${parsed.data.playbook ?? "common.yml"}...`, progress: 0.3, details: { step: "ansible" } });

    try {
      const result = await actionDef.execute(parsed.data);
      emitToolProgress({ toolName: "action_bootstrap", action: "services.bootstrap", status: "completed", message: "Bootstrap completed successfully", progress: 1, details: { result } });
      return { data: result, durationMs: Date.now() - started };
    } catch (error: any) {
      logger.error("action_bootstrap failed", { error: error.message });
      emitToolProgress({ toolName: "action_bootstrap", action: "services.bootstrap", status: "failed", message: `Action failed: ${error.message}`, progress: 0, details: { error: error.message } });
      return { error: error.message || "Action execution failed", durationMs: Date.now() - started };
    }
  }
}
