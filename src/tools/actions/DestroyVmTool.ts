import { BaseTool } from "../BaseTool";
import { createToolSchema } from "../tool-helpers";
import { actionRegistry } from "../../actions/registry";
import { DestroyVmSchema } from "../../actions/compute/destroy-vm";
import { emitToolProgress } from "../../agent/event-bus";
import { pceLogger as logger } from "../../pce/utils/logger";
import type { ToolSchema } from "../tool-schema";
import type { ExecutionContext, ExecutionResult } from "../../types/execution";

export class DestroyVmTool extends BaseTool {
  constructor() {
    super({
      name: "action_destroy_vm",
      description:
        "Destroy (delete) a VM on a Proxmox node using Terraform. " +
        "Either name or vmId must be provided. " +
        "Set dryRun=true to preview without executing.",
      categories: ["action", "compute", "terraform"],
      allowedAcls: ["admin"],
      risk: "high",
      requiresConfirmation: false,
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, DestroyVmSchema, {
      examples: [
        {
          description: "Destroy a VM by name",
          parameters: { name: "my-vm", dryRun: false },
        },
        {
          description: "Destroy a VM by ID",
          parameters: { vmId: 105, node: "yang", dryRun: false },
        },
        {
          description: "Preview VM destruction without applying",
          parameters: { name: "my-vm", dryRun: true },
        },
      ],
      notes: [
        "Either name or vmId is required",
        "node is optional but helps with validation",
        "Set dryRun: true to preview without executing Terraform",
        "Use twin_query find_vm_by_name to resolve a VM name to its ID before destroying",
      ],
    });
  }

  override getParameterSchema() {
    return DestroyVmSchema;
  }

  async execute(params: Record<string, any>, _context: ExecutionContext): Promise<ExecutionResult> {
    const started = Date.now();
    const parsed = DestroyVmSchema.safeParse(params);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}`, durationMs: Date.now() - started };
    }

    const actionDef = actionRegistry.get("compute.destroy_vm")!;
    emitToolProgress({ toolName: "action_destroy_vm", action: "compute.destroy_vm", status: "starting", message: "Preparing VM destruction...", progress: 0.1, details: { params: parsed.data } });
    emitToolProgress({ toolName: "action_destroy_vm", action: "compute.destroy_vm", status: "running", message: "Executing compute → destroy vm...", progress: 0.3, details: { step: "terraform" } });

    try {
      const result = await actionDef.execute(parsed.data);
      emitToolProgress({ toolName: "action_destroy_vm", action: "compute.destroy_vm", status: "completed", message: "compute → destroy vm completed successfully", progress: 1, details: { result } });
      return { data: result, durationMs: Date.now() - started };
    } catch (error: any) {
      logger.error("action_destroy_vm failed", { error: error.message });
      emitToolProgress({ toolName: "action_destroy_vm", action: "compute.destroy_vm", status: "failed", message: `Action failed: ${error.message}`, progress: 0, details: { error: error.message } });
      return { error: error.message || "Action execution failed", durationMs: Date.now() - started };
    }
  }
}
