import { z } from "zod";
import { BaseTool } from "./BaseTool";
import { actionRegistry } from "../actions/registry";
import { pceLogger as logger } from "../pce/utils/logger";
import type { ExecutionContext, ExecutionResult } from "../types/execution";
import type { ToolSchema } from "./tool-schema";
import { createToolSchema } from "./tool-helpers";

// Use z.any() wrapped in z.object() instead of z.record() to avoid schema issues
const ActionParams = z.object({
  action: z.string().describe("Action name (e.g., 'compute.create_vm')"),
  params: z.any().describe(
    "Action parameters as an object. " +
    "For compute.create_vm: {name: string, node: string, cores?: number, memory?: number, diskSize?: string, templateId?: number, dryRun?: boolean}. " +
    "templateId is the VM template ID to clone from (defaults to 9000). " +
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
      risk: "high", // Actions modify infrastructure
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
        ...actionExamples.slice(0, 2) // Include first 2 other actions as examples
      ],
      notes: [
        "Available actions: " + availableActions.map(a => a.name).join(", "),
        "For VM creation, use action: 'compute.create_vm'",
        "Actions use Terraform/Ansible for safe, deterministic operations",
        "Set dryRun: true to preview changes without applying them",
        "For compute.create_vm: templateId (number, optional) - VM template ID to clone from (defaults to 9000). Required if template doesn't exist on target node."
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

      // Execute action
      const result = await actionDef.execute(validatedParams);

      return {
        data: result,
        durationMs: Date.now() - started,
      };
    } catch (error: any) {
      logger.error("Action execution failed", { action, error: error.message });
      return {
        error: error.message || "Action execution failed",
        durationMs: Date.now() - started,
      };
    }
  }
}

