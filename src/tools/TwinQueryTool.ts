import { BaseTool } from "./BaseTool";
import { z } from "zod";
import type { ToolSchema } from "./tool-schema";
import { createToolSchema } from "./tool-helpers";
import type { ExecutionContext, ExecutionResult } from "../types/execution";
import { TwinQueryService } from "../twin";
import { formatInterfaceLine } from "../config/network-labels";

const TwinQueryParams = z.object({
  operation: z.enum([
    "describe_cluster",
    "list_all_vms",
    "vms_by_node",
    "vms_without_agent",
    "stopped_vms_on_node",
    "find_vm_by_name",
    "find_vm_by_id",
    "network_list_interfaces",
    "network_interfaces_by_node",
    "network_vms_by_subnet",
    "network_reachability",
    "vm_reachability_summary",
    "firewall_list_rules",
    "firewall_rules_by_chain",
    "firewall_rules_allowing_subnet",
    "firewall_rules_blocking_subnet",
    "firewall_rules_by_port",
    "firewall_exposure_map",
    "firewall_reachability_from_subnet",
    "firewall_reachability_from_chain",
    "firewall_rule_impact",
    "exposure_vm_analysis",
    "exposure_vms_by_subnet",
    "exposure_path",
    "exposure_internet_exposed",
    "node_temperature",
    "switch_list_vlans",
    "switch_ports_by_vlan",
  ]),
  params: z
    .object({
      nodeName: z.string().optional(),
      subnet: z.string().optional(),
      fromId: z.string().optional(),
      chain: z.string().optional(),
      ruleId: z.string().optional(),
      fromSubnet: z.string().optional(),
      toVmId: z.string().optional(),
      vmName: z.string().optional(),
      vmId: z
        .union([z.number(), z.string()])
        .optional()
        .describe(
          "A specific VM's name or id. REQUIRED for exposure_vm_analysis (a single VM's exposure). " +
            "Leave unset for cluster-wide operations (firewall_exposure_map with no vmId, exposure_internet_exposed) " +
            "— do not call exposure_vm_analysis for a 'list all nodes/VMs and their exposure' style question."
        ),
      vmKind: z.enum(["qemu", "lxc", "all"]).optional(),
      vlan: z.union([z.number(), z.string()]).optional(),
      port: z.union([z.number(), z.string()]).optional().describe("Port number or name (e.g. 8006, ssh) for firewall_rules_by_port."),
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
        "Query the digital twin for compute entities (nodes, VMs, relationships) with structured responses. Use this before calling live Proxmox tools. " +
        "IMPORTANT: When searching for a VM by name (e.g., 'code server', 'nginx', 'database'), use operation='find_vm_by_name' which searches across ALL nodes with case-insensitive partial matching. " +
        "Do NOT assume a VM is on a specific node - always search by name first. " +
        "For temperature queries: Use operation='node_temperature' WITHOUT nodeName param to get all nodes, or WITH nodeName for a specific node. " +
        "Note: For IP addresses, check the 'primaryIp' field on network interfaces (even if 'ips' array is empty). " +
        "If twin data doesn't have IPs, use proxmox_readonly get_vm_ip for real-time IP resolution. " +
        "For switch/VLAN questions (e.g. 'what VLANs are on the switch', 'what's on VLAN 40'), use operation='switch_list_vlans' or 'switch_ports_by_vlan' — " +
        "these read real switch/switch-port entities, distinct from the VM/node network interfaces network_list_interfaces returns.",
      categories: ["twin", "compute", "graph", "read"],
      allowedAcls: ["admin", "ops", "viewer"],
      risk: "low",
      classification: [
        { domain: "compute", compositeEligible: true },
        { domain: "network", compositeEligible: true },
        { domain: "firewall", compositeEligible: true },
        { domain: "metrics", compositeEligible: true },
      ],
    });
    this.service = service;
  }

  override getSchema(): ToolSchema {
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
          description: "Find VM by ID (handles ambiguity when same ID exists on multiple nodes/types)",
          parameters: { operation: "find_vm_by_id", params: { vmId: 100 } },
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
          description: "Find rules referencing a specific port (e.g. 'which rule permits access to port 8006')",
          parameters: { operation: "firewall_rules_by_port", params: { port: "8006" } },
        },
        {
          description: "Get exposure map for all VMs",
          parameters: { operation: "firewall_exposure_map" },
        },
        {
          description: "Get temperature for all nodes (preferred for 'all nodes' queries)",
          parameters: { operation: "node_temperature" },
        },
        {
          description: "Get temperature for a specific node",
          parameters: { operation: "node_temperature", params: { nodeName: "proxBig" } },
        },
        {
          description: "List VLANs configured on switches, grouped by declared vs observed",
          parameters: { operation: "switch_list_vlans" },
        },
        {
          description: "Find switch ports carrying VLAN 40",
          parameters: { operation: "switch_ports_by_vlan", params: { vlan: 40 } },
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

  private normalizeVmEntityId(value?: string | number): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value === "number") {
      return `compute-vm:${value}`;
    }
    return value;
  }

  /**
   * Like normalizeVmEntityId, but also resolves a bare VM display name (e.g.
   * "windowsVM", "opnsense" — not a canonical `compute-vm:node:id` string) to
   * its real entity id via a case-insensitive twin lookup. Callers upstream
   * (detectFirewallIntent's exposure_map extraction) only have the query text
   * to work with and can extract a display name but not a canonical id;
   * without this, exposure_vm_analysis/firewall_exposure_map silently matched
   * nothing and fell back to the unscoped, cluster-wide answer. See A-TQ-21/23.
   */
  private async resolveVmEntityId(value?: string | number): Promise<string | undefined> {
    const normalized = this.normalizeVmEntityId(value);
    if (!normalized || normalized.toLowerCase().startsWith("compute-vm:")) {
      return normalized;
    }
    try {
      const matches = await this.service.findVmByName(normalized, { verifyAgainstProxmox: false });
      const first = matches[0];
      if (first?.id) {
        return first.id;
      }
    } catch {
      // Fall through — return the raw value so the caller's own "not found"
      // handling still applies, rather than throwing here.
    }
    return normalized;
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
        "ruleId",
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
        case "list_all_vms": {
          const vmKind = this.normalizeVmKind(opParams?.vmKind as string | undefined);
          const data = await this.service.listAllVms(vmKind ?? undefined);
          return { data: { kind: "vm_list", data } };
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
        case "find_vm_by_id": {
          const vmId = opParams?.vmId;
          if (vmId === undefined || vmId === null) {
            return { error: "vmId is required for find_vm_by_id" };
          }
          const data = await this.service.findVmById(vmId as number | string);
          // If multiple VMs found with same ID, indicate ambiguity
          const isAmbiguous = data.length > 1;
          return { 
            data: { 
              kind: "vm_list", 
              vmId, 
              data,
              ambiguous: isAmbiguous,
              note: isAmbiguous ? `Multiple VMs found with ID ${vmId} on different nodes/types. All matches shown below.` : undefined
            } 
          };
        }
        case "network_list_interfaces": {
          const data = await this.service.listInterfaces();
          const ip = (iface: { primaryIp?: string; ips?: string[] }) =>
            iface.primaryIp ?? (Array.isArray(iface.ips) ? iface.ips[0] : undefined);
          const formattedData = data.map((iface: { name?: string; id?: string; primaryIp?: string; ips?: string[]; [k: string]: unknown }) => ({
            ...iface,
            labelLine: formatInterfaceLine(
              iface.name ?? (typeof iface.id === "string" ? iface.id.split(":").pop() ?? "interface" : "interface"),
              ip(iface),
              undefined
            ),
            _note: iface.primaryIp && (!iface.ips || iface.ips.length === 0)
              ? `IP address available in primaryIp field: ${iface.primaryIp}`
              : undefined,
          }));
          return { data: { kind: "network_interface_list", data: formattedData } };
        }
        case "network_interfaces_by_node": {
          const nodeName = opParams?.nodeName;
          if (!nodeName) {
            return { error: "nodeName is required for network_interfaces_by_node" };
          }
          const data = await this.service.interfacesByNode(nodeName);
          const ip = (iface: { primaryIp?: string; ips?: string[] }) =>
            iface.primaryIp ?? (Array.isArray(iface.ips) ? iface.ips[0] : undefined);
          const formattedData = data.map((iface: { name?: string; id?: string; primaryIp?: string; ips?: string[]; [k: string]: unknown }) => ({
            ...iface,
            labelLine: formatInterfaceLine(
              iface.name ?? (typeof iface.id === "string" ? iface.id.split(":").pop() ?? "interface" : "interface"),
              ip(iface),
              undefined
            ),
            _note: iface.primaryIp && (!iface.ips || iface.ips.length === 0)
              ? `IP address available in primaryIp field: ${iface.primaryIp}`
              : undefined,
          }));
          return { data: { kind: "network_interface_list", nodeName, data: formattedData } };
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
        case "vm_reachability_summary": {
          const vmId = opParams?.vmId;
          if (!vmId) {
            return { error: "vmId is required for vm_reachability_summary" };
          }
          const vmIdStr = typeof vmId === "number" ? `compute-vm:${vmId}` : vmId.toString();
          const data = await this.service.vmReachabilitySummary(vmIdStr);
          return { data: { kind: "vm_reachability_summary", data } };
        }
        case "firewall_list_rules": {
          const data = await this.service.listFirewallRules();
          const aliases = await this.service.listFirewallAliases();
          return { data: { kind: "firewall_rule_list", data, aliases } };
        }
        case "firewall_rules_by_chain": {
          const chain = opParams?.chain;
          if (!chain) {
            return { error: "chain is required for firewall_rules_by_chain" };
          }
          const data = await this.service.firewallRulesByChain(chain);
          const aliases = await this.service.listFirewallAliases();
          return { data: { kind: "firewall_rule_list", chain, data, aliases } };
        }
        case "firewall_rules_allowing_subnet": {
          const subnet = opParams?.subnet;
          if (!subnet) {
            return { error: "subnet is required for firewall_rules_allowing_subnet" };
          }
          const data = await this.service.rulesAllowingSubnet(subnet);
          const aliases = await this.service.listFirewallAliases();
          return { data: { kind: "firewall_rule_list", subnet, data, aliases } };
        }
        case "firewall_rules_blocking_subnet": {
          const subnet = opParams?.subnet;
          if (!subnet) {
            return { error: "subnet is required for firewall_rules_blocking_subnet" };
          }
          const data = await this.service.rulesBlockingSubnet(subnet);
          const aliases = await this.service.listFirewallAliases();
          return { data: { kind: "firewall_rule_list", subnet, data, aliases } };
        }
        case "firewall_rules_by_port": {
          const port = opParams?.port;
          if (port === undefined || port === null || port === "") {
            return { error: "port is required for firewall_rules_by_port" };
          }
          const data = await this.service.rulesByPort(String(port));
          return { data: { kind: "firewall_rule_list_by_port", port, data } };
        }
        case "firewall_exposure_map": {
          const vmId = opParams?.vmId;
          const vmEntityId = await this.resolveVmEntityId(vmId);
          const data = await this.service.exposureMap(vmEntityId);
          return { data: { kind: "exposure_map", vmId, data } };
        }
        case "firewall_reachability_from_subnet": {
          const subnet = opParams?.subnet;
          if (!subnet) {
            return { error: "subnet is required for firewall_reachability_from_subnet" };
          }
          const vmId = opParams?.vmId;
          const vmEntityId = this.normalizeVmEntityId(vmId);
          const data = await this.service.reachableFromSubnet(subnet, vmEntityId);
          return { data: { kind: "reachability_subnet", subnet, data } };
        }
        case "firewall_reachability_from_chain": {
          const chain = opParams?.chain;
          if (!chain) {
            return { error: "chain is required for firewall_reachability_from_chain" };
          }
          const data = await this.service.reachableFromInterfaceChain(chain);
          return { data: { kind: "reachability_chain", chain, data } };
        }
        case "firewall_rule_impact": {
          const ruleId = opParams?.ruleId;
          if (!ruleId) {
            return { error: "ruleId is required for firewall_rule_impact" };
          }
          const data = await this.service.ruleImpact(ruleId);
          return { data: { kind: "rule_impact", data } };
        }
        case "exposure_vm_analysis": {
          const vmId = opParams?.vmId;
          if (!vmId) {
            return { error: "vmId is required for exposure_vm_analysis" };
          }
          const vmEntityId = await this.resolveVmEntityId(vmId);
          if (!vmEntityId) {
            return { error: "vmId is required for exposure_vm_analysis" };
          }
          const data = await this.service.vmExposure(vmEntityId);
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
        case "node_temperature": {
          const nodeName = opParams?.nodeName;
          const data = await this.service.getNodeTemperature(nodeName);
          return { data: { kind: "node_temperature", data } };
        }
        case "switch_list_vlans": {
          const data = await this.service.listSwitchVlans();
          return { data: { kind: "switch_vlan_list", data } };
        }
        case "switch_ports_by_vlan": {
          const vlanRaw = opParams?.vlan;
          if (vlanRaw === undefined || vlanRaw === null) {
            return { error: "vlan is required for switch_ports_by_vlan" };
          }
          const vlan = typeof vlanRaw === "string" ? parseInt(vlanRaw, 10) : vlanRaw;
          if (Number.isNaN(vlan)) {
            return { error: `Invalid vlan value: ${vlanRaw}` };
          }
          const data = await this.service.switchPortsByVlan(vlan);
          return { data: { kind: "switch_port_list", vlan, data } };
        }
        default:
          return { error: `Unsupported operation: ${operation}` };
      }
    } catch (error: any) {
      return { error: `Twin query failed: ${error.message}` };
    }
  }
}
