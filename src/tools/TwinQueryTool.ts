import { BaseTool } from "./BaseTool";
import { z } from "zod";
import type { ToolSchema } from "./tool-schema";
import { createToolSchema } from "./tool-helpers";
import type { ExecutionContext, ExecutionResult } from "../types/execution";
import { TwinQueryService } from "../twin";

const TwinQueryParams = z.object({
  operation: z.enum([
    "describe_cluster",
    "vms_by_node",
    "vms_without_agent",
    "stopped_vms_on_node",
  ]),
  params: z
    .object({
      nodeName: z.string().optional(),
    })
    .partial()
    .optional(),
});

export type TwinQueryParams = z.infer<typeof TwinQueryParams>;

export class TwinQueryTool extends BaseTool {
  private service: TwinQueryService;

  constructor(service: TwinQueryService = new TwinQueryService()) {
    super({
      name: "twin_query",
      description:
        "Query the digital twin for compute entities (nodes, VMs, relationships) with structured responses. Use this before calling live Proxmox tools.",
      categories: ["twin", "compute", "graph", "read"],
      allowedAcls: ["admin", "ops", "viewer"],
      risk: "low",
    });
    this.service = service;
  }

  getSchema(): ToolSchema {
    return createToolSchema(this, TwinQueryParams, {
      examples: [
        {
          description: "Describe the entire Proxmox cluster",
          parameters: { operation: "describe_cluster" },
        },
        {
          description: "List VMs running on node proxBig",
          parameters: { operation: "vms_by_node", params: { nodeName: "proxBig" } },
        },
        {
          description: "List VMs that lack guest agent data",
          parameters: { operation: "vms_without_agent" },
        },
        {
          description: "List VMs on proxBig that are stopped",
          parameters: { operation: "stopped_vms_on_node", params: { nodeName: "proxBig" } },
        },
      ],
    });
  }

  override getParameterSchema() {
    return TwinQueryParams;
  }

  async execute(
    params: Record<string, unknown>,
    _context: ExecutionContext
  ): Promise<ExecutionResult> {
    const parsed = TwinQueryParams.safeParse(params);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}` };
    }

    const { operation, params: opParams } = parsed.data;
    try {
      switch (operation) {
        case "describe_cluster": {
          const data = await this.service.describeCluster();
          return { data: { kind: "cluster_overview", data } };
        }
        case "vms_by_node": {
          const nodeName = opParams?.nodeName;
          if (!nodeName) {
            return { error: "nodeName is required for vms_by_node" };
          }
          const data = await this.service.vmsByNode(nodeName);
          return { data: { kind: "vm_list", nodeName, data } };
        }
        case "vms_without_agent": {
          const data = await this.service.vmsWithoutAgent();
          return { data: { kind: "vm_list", data } };
        }
        case "stopped_vms_on_node": {
          const nodeName = opParams?.nodeName;
          if (!nodeName) {
            return { error: "nodeName is required for stopped_vms_on_node" };
          }
          const data = await this.service.stoppedVmsOnNode(nodeName);
          return { data: { kind: "vm_list", nodeName, data } };
        }
        default:
          return { error: `Unsupported operation: ${operation}` };
      }
    } catch (error: any) {
      return { error: `Twin query failed: ${error.message}` };
    }
  }
}

