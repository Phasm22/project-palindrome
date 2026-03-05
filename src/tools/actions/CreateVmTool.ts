import { BaseTool } from "../BaseTool";
import { createToolSchema } from "../tool-helpers";
import { actionRegistry } from "../../actions/registry";
import { CreateVmSchema } from "../../actions/compute/create-vm";
import { emitToolProgress } from "../../agent/event-bus";
import { pceLogger as logger } from "../../pce/utils/logger";
import type { ToolSchema } from "../tool-schema";
import type { ExecutionContext, ExecutionResult } from "../../types/execution";

export class CreateVmTool extends BaseTool {
  constructor() {
    super({
      name: "action_create_vm",
      description:
        "Create a new VM on a Proxmox node using Terraform. " +
        "Node names are canonicalized and availability-aware. " +
        "If name is omitted a palindrome name is auto-generated. " +
        "If vmBridge/datastore/templateId are omitted the action selects from discovered options on the node. " +
        "Set bootstrap=true to run Ansible common.yml after VM creation. " +
        "Set dryRun=true to preview changes without applying them.",
      categories: ["action", "compute", "terraform"],
      allowedAcls: ["admin"],
      risk: "high",
      requiresConfirmation: false,
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, CreateVmSchema, {
      examples: [
        {
          description: "Create a VM on yang with defaults",
          parameters: { node: "yang", cores: 2, memory: 4096, diskSize: "20G", dryRun: false },
        },
        {
          description: "Create a VM with bootstrap and auto-generated name",
          parameters: { node: "YANG", cores: 2, memory: 4096, diskSize: "20G", bootstrap: true, dryRun: false },
        },
        {
          description: "Preview VM creation without applying",
          parameters: { node: "yin", cores: 4, memory: 8192, diskSize: "40G", dryRun: true },
        },
      ],
      notes: [
        "Either provide a name or a palindrome name will be auto-generated",
        "node is required — use twin_query to discover available nodes first",
        "Set dryRun: true to preview without executing Terraform",
        "Set vmBridge to 'vmbr2' for pre-configured VLAN bridges, or use vlanId with vmbr0 for VLAN tagging",
      ],
    });
  }

  override getParameterSchema() {
    return CreateVmSchema;
  }

  async execute(params: Record<string, any>, _context: ExecutionContext): Promise<ExecutionResult> {
    const started = Date.now();
    const parsed = CreateVmSchema.safeParse(params);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}`, durationMs: Date.now() - started };
    }

    const actionDef = actionRegistry.get("compute.create_vm")!;
    emitToolProgress({ toolName: "action_create_vm", action: "compute.create_vm", status: "starting", message: "Preparing VM creation...", progress: 0.1, details: { params: parsed.data } });
    emitToolProgress({ toolName: "action_create_vm", action: "compute.create_vm", status: "running", message: "Executing compute → create vm...", progress: 0.3, details: { step: "terraform" } });

    try {
      const result = await actionDef.execute(parsed.data);
      emitToolProgress({ toolName: "action_create_vm", action: "compute.create_vm", status: "completed", message: "compute → create vm completed successfully", progress: 1, details: { result } });
      return { data: result, durationMs: Date.now() - started };
    } catch (error: any) {
      logger.error("action_create_vm failed", { error: error.message });
      emitToolProgress({ toolName: "action_create_vm", action: "compute.create_vm", status: "failed", message: `Action failed: ${error.message}`, progress: 0, details: { error: error.message } });
      return { error: error.message || "Action execution failed", durationMs: Date.now() - started };
    }
  }
}
