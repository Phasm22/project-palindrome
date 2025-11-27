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
    "network_list_interfaces",
    "network_interfaces_by_node",
    "network_vms_by_subnet",
    "network_reachability",
    "firewall_list_rules",
    "firewall_rules_by_chain",
    "firewall_rules_allowing_subnet",
    "firewall_rules_blocking_subnet",
    "firewall_exposure_map",
  ]),
  params: z
    .object({
      nodeName: z.string().optional(),
      subnet: z.string().optional(),
      fromId: z.string().optional(),
      chain: z.string().optional(),
      vmId: z.string().optional(),
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
        {
          description: "Show all network interfaces",
          parameters: { operation: "network_list_interfaces" },
        },
        {
          description: "List interfaces on proxBig",
          parameters: { operation: "network_interfaces_by_node", params: { nodeName: "proxBig" } },
        },
        {
          description: "Find VMs sharing subnet 172.16.0.0/22",
          parameters: { operation: "network_vms_by_subnet", params: { subnet: "172.16.0.0/22" } },
        },
        {
          description: "List all firewall rules",
          parameters: { operation: "firewall_list_rules" },
        },
        {
          description: "List firewall rules for interface chain",
          parameters: { operation: "firewall_rules_by_chain", params: { chain: "chain:em0" } },
        },
        {
          description: "Find rules allowing access to subnet",
          parameters: { operation: "firewall_rules_allowing_subnet", params: { subnet: "172.16.0.0/22" } },
        },
        {
          description: "Get exposure map for all VMs",
          parameters: { operation: "firewall_exposure_map" },
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
        case "network_list_interfaces": {
          const data = await this.service.listInterfaces();
          return { data: { kind: "network_interface_list", data } };
        }
        case "network_interfaces_by_node": {
          const nodeName = opParams?.nodeName;
          if (!nodeName) {
            return { error: "nodeName is required for network_interfaces_by_node" };
          }
          const data = await this.service.interfacesByNode(nodeName);
          return { data: { kind: "network_interface_list", nodeName, data } };
        }
        case "network_vms_by_subnet": {
          const subnet = opParams?.subnet;
          if (!subnet) {
            return { error: "subnet is required for network_vms_by_subnet" };
          }
          const data = await this.service.vmsBySubnet(subnet);
          return { data: { kind: "vm_list", subnet, data } };
        }
        case "network_reachability": {
          const fromId = opParams?.fromId;
          if (!fromId) {
            return { error: "fromId is required for network_reachability" };
          }
          const data = await this.service.reachability(fromId);
          return { data: { kind: "reachability", fromId, data } };
        }
        case "firewall_list_rules": {
          const data = await this.service.listFirewallRules();
          return { data: { kind: "firewall_rule_list", data } };
        }
        case "firewall_rules_by_chain": {
          const chain = opParams?.chain;
          if (!chain) {
            return { error: "chain is required for firewall_rules_by_chain" };
          }
          const data = await this.service.firewallRulesByChain(chain);
          return { data: { kind: "firewall_rule_list", chain, data } };
        }
        case "firewall_rules_allowing_subnet": {
          const subnet = opParams?.subnet;
          if (!subnet) {
            return { error: "subnet is required for firewall_rules_allowing_subnet" };
          }
          const data = await this.service.rulesAllowingSubnet(subnet);
          return { data: { kind: "firewall_rule_list", subnet, data } };
        }
        case "firewall_rules_blocking_subnet": {
          const subnet = opParams?.subnet;
          if (!subnet) {
            return { error: "subnet is required for firewall_rules_blocking_subnet" };
          }
          const data = await this.service.rulesBlockingSubnet(subnet);
          return { data: { kind: "firewall_rule_list", subnet, data } };
        }
        case "firewall_exposure_map": {
          const vmId = opParams?.vmId;
          const data = await this.service.exposureMap(vmId);
          return { data: { kind: "exposure_map", vmId, data } };
        }
        default:
          return { error: `Unsupported operation: ${operation}` };
      }
    } catch (error: any) {
      return { error: `Twin query failed: ${error.message}` };
    }
  }
}

