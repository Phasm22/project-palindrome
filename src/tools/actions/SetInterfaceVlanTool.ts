import { BaseTool } from "../BaseTool";
import { createToolSchema } from "../tool-helpers";
import { actionRegistry } from "../../actions/registry";
import { SetInterfaceVlanSchema } from "../../actions/network/set-interface-vlan";
import { emitToolProgress } from "../../agent/event-bus";
import { pceLogger as logger } from "../../pce/utils/logger";
import type { ToolSchema } from "../tool-schema";
import type { ExecutionContext, ExecutionResult } from "../../types/execution";

export class SetInterfaceVlanTool extends BaseTool {
  constructor() {
    super({
      name: "action_set_interface_vlan",
      description:
        "Assign a VM to an existing VLAN by updating its network interface configuration. " +
        "Validates that the VLAN exists in OPNsense and the digital twin before assignment. " +
        "Set dryRun=true to preview without applying.",
      categories: ["action", "network", "vlan", "proxmox"],
      allowedAcls: ["admin"],
      risk: "high",
      requiresConfirmation: false,
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, SetInterfaceVlanSchema, {
      examples: [
        {
          description: "Assign VM to VLAN 50",
          parameters: { vmid: 105, node: "yang", vlanId: 50, bridge: "vmbr0", dryRun: false },
        },
        {
          description: "Preview VLAN assignment",
          parameters: { vmid: 105, node: "yang", vlanId: 50, dryRun: true },
        },
      ],
      notes: [
        "vmid (number) and node are required",
        "VLAN must already exist in OPNsense — this does not create a new VLAN",
        "Default bridge is 'vmbr0'",
        "Use twin_query to resolve a VM name to its ID first",
        "Set dryRun: true to preview without applying",
      ],
    });
  }

  override getParameterSchema() {
    return SetInterfaceVlanSchema;
  }

  async execute(params: Record<string, any>, _context: ExecutionContext): Promise<ExecutionResult> {
    const started = Date.now();
    const parsed = SetInterfaceVlanSchema.safeParse(params);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}`, durationMs: Date.now() - started };
    }

    const actionDef = actionRegistry.get("network.set_interface_vlan")!;
    emitToolProgress({ toolName: "action_set_interface_vlan", action: "network.set_interface_vlan", status: "starting", message: "Preparing VLAN assignment...", progress: 0.1, details: { params: parsed.data } });
    emitToolProgress({ toolName: "action_set_interface_vlan", action: "network.set_interface_vlan", status: "running", message: "Setting interface VLAN...", progress: 0.3, details: { step: "proxmox+opnsense" } });

    try {
      const result = await actionDef.execute(parsed.data);
      emitToolProgress({ toolName: "action_set_interface_vlan", action: "network.set_interface_vlan", status: "completed", message: "VLAN assignment completed successfully", progress: 1, details: { result } });
      return { data: result, durationMs: Date.now() - started };
    } catch (error: any) {
      logger.error("action_set_interface_vlan failed", { error: error.message });
      emitToolProgress({ toolName: "action_set_interface_vlan", action: "network.set_interface_vlan", status: "failed", message: `Action failed: ${error.message}`, progress: 0, details: { error: error.message } });
      return { error: error.message || "Action execution failed", durationMs: Date.now() - started };
    }
  }
}
