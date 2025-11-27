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
    "find_vm_by_name",
    "network_list_interfaces",
    "network_interfaces_by_node",
    "network_vms_by_subnet",
    "network_reachability",
    "firewall_list_rules",
    "firewall_rules_by_chain",
    "firewall_rules_allowing_subnet",
    "firewall_rules_blocking_subnet",
    "firewall_exposure_map",
    "exposure_vm_analysis",
    "exposure_vms_by_subnet",
    "exposure_path",
    "exposure_internet_exposed",
  ]),
  params: z
    .object({
      nodeName: z.string().optional(),
      subnet: z.string().optional(),
      fromId: z.string().optional(),
      chain: z.string().optional(),
      vmId: z.string().optional(),
      fromSubnet: z.string().optional(),
      toVmId: z.string().optional(),
      vmName: z.string().optional(),
      vmKind: z.enum(["qemu", "lxc", "all"]).optional(),
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
          description: "Find VM by name (searches across all nodes)",
          parameters: { operation: "find_vm_by_name", params: { vmName: "SentinelZero" } },
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

  private normalizeVmKind(
    value?: string
  ): "qemu" | "lxc" | null | undefined {
    if (!value) {
      return undefined;
    }
    if (value === "all") {
      return null;
    }
    if (value === "qemu" || value === "lxc") {
      return value;
    }
    return undefined;
  }

  async execute(
    params: Record<string, unknown>,
    _context: ExecutionContext
  ): Promise<ExecutionResult> {
    const normalizedParams: Record<string, unknown> = { ...params };

    if (normalizedParams.params == null) {
      const fallbackKeys = [
        "nodeName",
        "subnet",
        "fromId",
        "chain",
        "vmId",
        "fromSubnet",
        "toVmId",
        "vmName",
        "vmKind",
      ] as const;
      const fallbackParams: Record<string, unknown> = {};
      let hasFallback = false;
      for (const key of fallbackKeys) {
        if (normalizedParams[key] !== undefined) {
          fallbackParams[key] = normalizedParams[key];
          delete normalizedParams[key];
          hasFallback = true;
        }
      }
      if (hasFallback) {
        normalizedParams.params = fallbackParams;
      }
    }

    const parsed = TwinQueryParams.safeParse(normalizedParams);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}` };
    }

    const { operation, params: opParams } = parsed.data;
    try {
      switch (operation) {
        case "describe_cluster": {
          const vmKind = this.normalizeVmKind(opParams?.vmKind as string | undefined);
          const data = await this.service.describeCluster(vmKind ?? undefined);
          return { data: { kind: "cluster_overview", data } };
        }
        case "vms_by_node": {
          const nodeName = opParams?.nodeName;
          if (!nodeName) {
            return { error: "nodeName is required for vms_by_node" };
          }
          const vmKind = this.normalizeVmKind(opParams?.vmKind as string | undefined);
          const data = await this.service.vmsByNode(nodeName, { vmKind: vmKind ?? undefined });
          return { data: { kind: "vm_list", nodeName, data } };
        }
        case "vms_without_agent": {
          const vmKind = this.normalizeVmKind(opParams?.vmKind as string | undefined);
          const data = await this.service.vmsWithoutAgent(vmKind ?? undefined);
          return { data: { kind: "vm_list", data } };
        }
        case "stopped_vms_on_node": {
          const nodeName = opParams?.nodeName;
          if (!nodeName) {
            return { error: "nodeName is required for stopped_vms_on_node" };
          }
          const vmKind = this.normalizeVmKind(opParams?.vmKind as string | undefined);
          const data = await this.service.stoppedVmsOnNode(nodeName, { vmKind: vmKind ?? undefined });
          return { data: { kind: "vm_list", nodeName, data } };
        }
        case "find_vm_by_name": {
          const vmName = opParams?.vmName;
          if (!vmName) {
            return { error: "vmName is required for find_vm_by_name" };
          }
          const vmKind = this.normalizeVmKind(opParams?.vmKind as string | undefined);
          const data = await this.service.findVmByName(vmName, { vmKind: vmKind ?? undefined });
          return { data: { kind: "vm_list", vmName, data } };
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
        case "exposure_vm_analysis": {
          const vmId = opParams?.vmId;
          if (!vmId) {
            return { error: "vmId is required for exposure_vm_analysis" };
          }
          const data = await this.service.vmExposure(vmId);
          return { data: { kind: "vm_exposure", vmId, data } };
        }
        case "exposure_vms_by_subnet": {
          const subnet = opParams?.subnet;
          if (!subnet) {
            return { error: "subnet is required for exposure_vms_by_subnet" };
          }
          const data = await this.service.vmsExposedToSubnet(subnet);
          return { data: { kind: "vms_exposed_to_subnet", subnet, data } };
        }
        case "exposure_path": {
          const fromSubnet = opParams?.fromSubnet;
          const toVmId = opParams?.toVmId;
          if (!fromSubnet || !toVmId) {
            return { error: "fromSubnet and toVmId are required for exposure_path" };
          }
          const data = await this.service.exposurePath(fromSubnet, toVmId);
          return { data: { kind: "exposure_path", fromSubnet, toVmId, data } };
        }
        case "exposure_internet_exposed": {
          const data = await this.service.internetExposedVms();
          return { data: { kind: "internet_exposed_vms", data } };
        }
        default:
          return { error: `Unsupported operation: ${operation}` };
      }
    } catch (error: any) {
      return { error: `Twin query failed: ${error.message}` };
    }
  }
}

