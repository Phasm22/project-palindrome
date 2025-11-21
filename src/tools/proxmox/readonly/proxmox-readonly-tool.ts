import { ProxmoxReadOnlyBase } from "./base";
import { z } from "zod";
import type { ToolSchema } from "../../tool-schema";
import { createToolSchema } from "../../tool-helpers";
import type { ExecutionResult, ExecutionContext } from "../../../types/execution";
import { ProxmoxClient } from "../client";
import { normalizeProxmoxResponse, normalizeMemory } from "./normalization";
import { pceLogger } from "../../../pce/utils/logger";
import { promises as dns } from "dns";

/**
 * Schema for Proxmox read-only tool parameters
 * Supports 15 distinct read-only actions across Nodes, VMs, and Cluster
 */
export const ProxmoxReadOnlyParams = z.object({
  action: z
    .enum([
      // Node-Level (5 actions)
      "list_nodes",
      "node_status",
      "node_resources",
      "node_disks",
      "node_network_interfaces",

      // VM-Level (7 actions)
      "list_vms",
      "get_vm_status",
      "get_vm_config",
      "get_vm_network",
      "get_vm_snapshots",
      "get_vm_ip", // Get VM IP via guest agent
      "get_lxc_config", // Get LXC container config

      // Cluster-Level (5 actions)
      "cluster_resources", // Use this to find VMID, node, and type when given a VM/container NAME
      "cluster_status",
      "cluster_ceph_status",
      "ha_groups",
      "ha_resources",
    ])
    .describe("The read-only Proxmox operation to perform"),

  // Optional parameters for specific actions
  node: z.string().optional().describe("Node name (required for node-level and VM-level actions)"),
  vmid: z.number().optional().describe("VM ID (required for VM-level actions)"),
  type: z
    .enum(["qemu", "lxc"])
    .optional()
    .describe("VM type (qemu or lxc, default: qemu)"),
});

export type ProxmoxReadOnlyParams = z.infer<typeof ProxmoxReadOnlyParams>;

/**
 * Unified Proxmox Read-Only Tool
 * Provides comprehensive read-only access to Proxmox cluster state
 */
export class ProxmoxReadOnlyTool extends ProxmoxReadOnlyBase {
  constructor() {
    super({
      name: "proxmox_readonly",
      description:
        "Comprehensive read-only access to Proxmox cluster state (Nodes, VMs, Cluster). All operations return structured JSON data.",
      categories: ["proxmox", "virtualization", "infrastructure", "cluster"],
      allowedAcls: ["admin", "ops", "viewer"],
      risk: "low",
    });
  }

  getSchema(): ToolSchema {
    return createToolSchema(this, ProxmoxReadOnlyParams, {
      examples: [
        {
          description: "List all nodes in the cluster",
          parameters: { action: "list_nodes" },
        },
        {
          description: "Get node status",
          parameters: { action: "node_status", node: "pve1" },
        },
        {
          description: "List all VMs",
          parameters: { action: "list_vms", node: "pve1" },
        },
        {
          description: "Get VM status",
          parameters: { action: "get_vm_status", node: "pve1", vmid: 101 },
        },
        {
          description: "Get cluster status",
          parameters: { action: "cluster_status" },
        },
        {
          description: "Find VM/container by name (e.g., find 'aiMarketBot' to get its VMID, node, and type)",
          parameters: { action: "cluster_resources" },
        },
        {
          description: "Get VM IP address via guest agent",
          parameters: { action: "get_vm_ip", node: "yang", vmid: 211, type: "qemu" },
        },
        {
          description: "Get LXC container configuration",
          parameters: { action: "get_lxc_config", node: "yang", vmid: 100 },
        },
      ],
      notes: [
        "All operations are strictly read-only. Write operations will return OPERATION_FORBIDDEN error.",
        "All responses are structured JSON objects with normalized data (memory in MB/GB, timestamps in ISO8601).",
        "Internal IP addresses, MAC addresses, and credentials are automatically sanitized from responses.",
      ],
    });
  }

  getParameterSchema() {
    return ProxmoxReadOnlyParams;
  }

  async execute(
    params: Record<string, any>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const parsed = ProxmoxReadOnlyParams.safeParse(params);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}` };
    }

    // Validate read-only
    const readOnlyCheck = this.validateReadOnly(parsed.data.action);
    if (readOnlyCheck) {
      return readOnlyCheck;
    }

    const client = this.getApiClient();
    const { action, ...actionParams } = parsed.data;

    // Route to appropriate handler based on action
    return this.executeApiCall(
      () => this.handleAction(action, actionParams, client),
      context
    );
  }

  /**
   * Route action to appropriate handler
   */
  private async handleAction(
    action: string,
    params: Record<string, any>,
    client: ProxmoxClient
  ): Promise<{ data: any; metadata: any }> {
    // Node-level actions
    if (
      action.startsWith("node_") ||
      action === "list_nodes" ||
      action === "list_vms"
    ) {
      return this.handleNodeAction(action, params, client);
    }

    // VM-level actions
    if (action.startsWith("get_vm_") || action === "get_lxc_config") {
      return this.handleVmAction(action, params, client);
    }

    // Cluster-level actions
    if (action.startsWith("cluster_") || action.startsWith("ha_")) {
      return this.handleClusterAction(action, params, client);
    }

    throw new Error(`Unknown action: ${action}`);
  }

  /**
   * Handle node-level actions
   */
  private async handleNodeAction(
    action: string,
    params: Record<string, any>,
    client: ProxmoxClient
  ): Promise<{ data: any; metadata: any }> {
    switch (action) {
      case "list_nodes":
        return this.listNodes(client);

      case "node_status":
        if (!params.node) {
          throw new Error("node parameter required for node_status");
        }
        return this.getNodeStatus(client, params.node);

      case "node_resources":
        if (!params.node) {
          throw new Error("node parameter required for node_resources");
        }
        return this.getNodeResources(client, params.node);

      case "node_disks":
        if (!params.node) {
          throw new Error("node parameter required for node_disks");
        }
        return this.getNodeDisks(client, params.node);

      case "node_network_interfaces":
        if (!params.node) {
          throw new Error("node parameter required for node_network_interfaces");
        }
        return this.getNodeNetworkInterfaces(client, params.node);

      case "list_vms":
        // If node is not provided, use cluster_resources to list all VMs across the cluster
        if (!params.node) {
          return this.listVmsFromCluster(client, params.type);
        }
        return this.listVms(client, params.node, params.type || "qemu");

      default:
        throw new Error(`Unknown node action: ${action}`);
    }
  }

  /**
   * Handle VM-level actions
   */
  private async handleVmAction(
    action: string,
    params: Record<string, any>,
    client: ProxmoxClient
  ): Promise<{ data: any; metadata: any }> {
    if (!params.node) {
      throw new Error(
        `node parameter required for VM actions. ` +
        `Use action "cluster_resources" first to find the node name for a VM/container, ` +
        `or use action "list_nodes" to see available nodes. ` +
        `Example: {"action": "${action}", "node": "YANG", "vmid": ${params.vmid || "XXX"}}`
      );
    }
    if (!params.vmid) {
      throw new Error(
        `vmid parameter required for VM actions. ` +
        `Use action "cluster_resources" first to find the VMID for a VM/container by name. ` +
        `Example: {"action": "${action}", "node": "${params.node || "XXX"}", "vmid": 108}`
      );
    }

    // Auto-detect VM type if not specified by trying qemu first, then lxc
    let vmType = params.type;
    if (!vmType) {
      try {
        // Try qemu first (most common)
        await client.get(`/nodes/${params.node}/qemu/${params.vmid}/status/current`);
        vmType = "qemu";
      } catch (error: any) {
        // If qemu fails with 404/403/500, try lxc (500 can indicate wrong type)
        const status = error?.response?.status;
        if (status === 404 || status === 403 || status === 500) {
          try {
            await client.get(`/nodes/${params.node}/lxc/${params.vmid}/status/current`);
            vmType = "lxc";
          } catch (lxcError: any) {
            // If both fail, default to qemu and let the error propagate
            vmType = "qemu";
          }
        } else {
          // For other errors, default to qemu
          vmType = "qemu";
        }
      }
    }

    switch (action) {
      case "get_vm_status":
        return this.getVmStatus(client, params.node, params.vmid, vmType);

      case "get_vm_config":
        return this.getVmConfig(client, params.node, params.vmid, vmType);

      case "get_vm_network":
        return this.getVmNetwork(client, params.node, params.vmid, vmType);

      case "get_vm_snapshots":
        return this.getVmSnapshots(client, params.node, params.vmid, vmType);

      case "get_vm_ip":
        return this.getVmIP(client, params.node, params.vmid, vmType);

      case "get_lxc_config":
        return this.getLxcConfig(client, params.node, params.vmid);

      default:
        throw new Error(`Unknown VM action: ${action}`);
    }
  }

  /**
   * Handle cluster-level actions
   */
  private async handleClusterAction(
    action: string,
    params: Record<string, any>,
    client: ProxmoxClient
  ): Promise<{ data: any; metadata: any }> {
    switch (action) {
      case "cluster_resources":
        return this.getClusterResources(client);

      case "cluster_status":
        return this.getClusterStatus(client);

      case "cluster_ceph_status":
        return this.getClusterCephStatus(client);

      case "ha_groups":
        return this.getHaGroups(client);

      case "ha_resources":
        return this.getHaResources(client);

      default:
        throw new Error(`Unknown cluster action: ${action}`);
    }
  }

  // ==================== Node-Level Actions ====================

  /**
   * List all nodes in the cluster
   */
  private async listNodes(
    client: ProxmoxClient
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get("/nodes");
    const nodes = result.data.data || [];

    const normalized = nodes.map((node: any) =>
      normalizeProxmoxResponse({
        node: node.node,
        status: node.status,
        cpu: node.cpu,
        level: node.level,
        maxcpu: node.maxcpu,
        maxmem: node.maxmem,
        mem: node.mem,
        uptime: node.uptime,
      })
    );

    return {
      data: { nodes: normalized, count: normalized.length },
      metadata: result.metadata,
    };
  }

  /**
   * Get node status
   */
  private async getNodeStatus(
    client: ProxmoxClient,
    node: string
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get(`/nodes/${node}/status`);
    const status = result.data.data || {};

    const normalized = normalizeProxmoxResponse({
      node,
      ...status,
    });

    return {
      data: normalized,
      metadata: result.metadata,
    };
  }

  /**
   * Get node resources (CPU, memory, disk, network)
   */
  private async getNodeResources(
    client: ProxmoxClient,
    node: string
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get(`/nodes/${node}/status`);
    const status = result.data.data || {};

    // Normalize with memory fields at top level so normalization works correctly
    const normalized = normalizeProxmoxResponse({
      node,
      status: status.status,
      cpu: status.cpu,
      maxcpu: status.maxcpu,
      mem: status.mem,
      maxmem: status.maxmem,
      uptime: status.uptime,
      kversion: status.kversion,
      pveversion: status.pveversion,
      // Also include structured format for convenience
      cpu_info: {
        usage: status.cpu,
        cores: status.maxcpu,
      },
      memory_info: {
        used: status.mem,
        total: status.maxmem,
        free: status.maxmem - (status.mem || 0),
        used_normalized: normalizeMemory(status.mem),
        total_normalized: normalizeMemory(status.maxmem),
      },
    });

    return {
      data: normalized,
      metadata: result.metadata,
    };
  }

  /**
   * Get node disk information
   */
  private async getNodeDisks(
    client: ProxmoxClient,
    node: string
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get(`/nodes/${node}/disks/list`);
    const disks = result.data.data || [];

    const normalized = disks.map((disk: any) =>
      normalizeProxmoxResponse({
        devpath: disk.devpath,
        gpt: disk.gpt,
        model: disk.model,
        size: disk.size,
        type: disk.type,
        used: disk.used,
        vendor: disk.vendor,
        wwn: disk.wwn,
      })
    );

    return {
      data: { node, disks: normalized, count: normalized.length },
      metadata: result.metadata,
    };
  }

  /**
   * Get node network interfaces
   */
  private async getNodeNetworkInterfaces(
    client: ProxmoxClient,
    node: string
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get(`/nodes/${node}/network`);
    const interfaces = result.data.data || [];

    const normalized = interfaces.map((iface: any) =>
      normalizeProxmoxResponse({
        iface: iface.iface,
        type: iface.type,
        method: iface.method,
        address: iface.address,
        netmask: iface.netmask,
        gateway: iface.gateway,
        active: iface.active,
        autostart: iface.autostart,
        families: iface.families,
      })
    );

    return {
      data: { node, interfaces: normalized, count: normalized.length },
      metadata: result.metadata,
    };
  }

  /**
   * List all VMs on a node
   */
  /**
   * List VMs from cluster resources (when node is not specified)
   */
  private async listVmsFromCluster(
    client: ProxmoxClient,
    type?: "qemu" | "lxc"
  ): Promise<{ data: any; metadata: any }> {
    const clusterResult = await this.getClusterResources(client);
    let vms = clusterResult.data.resources || [];

    // Filter by type if specified
    if (type) {
      vms = vms.filter((vm: any) => vm.type === type);
    }

    return {
      data: { 
        vms, 
        count: vms.length,
        ...(type && { type }),
        note: "Listed from cluster resources (all nodes)"
      },
      metadata: clusterResult.metadata,
    };
  }

  private async listVms(
    client: ProxmoxClient,
    node: string,
    type: "qemu" | "lxc"
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get(`/nodes/${node}/${type}`);
    const vms = result.data.data || [];

    const normalized = vms.map((vm: any) =>
      normalizeProxmoxResponse({
        vmid: vm.vmid,
        name: vm.name,
        status: vm.status,
        cpu: vm.cpu,
        mem: vm.mem,
        maxmem: vm.maxmem,
        maxdisk: vm.maxdisk,
        disk: vm.disk,
        uptime: vm.uptime,
        type,
      })
    );

    return {
      data: { node, type, vms: normalized, count: normalized.length },
      metadata: result.metadata,
    };
  }

  // ==================== VM-Level Actions ====================

  /**
   * Get VM status
   */
  private async getVmStatus(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    type: "qemu" | "lxc"
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get(`/nodes/${node}/${type}/${vmid}/status/current`);
    const status = result.data.data || {};

    const normalized = normalizeProxmoxResponse({
      node,
      vmid,
      type,
      ...status,
    });

    return {
      data: normalized,
      metadata: result.metadata,
    };
  }

  /**
   * Get VM configuration
   */
  private async getVmConfig(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    type: "qemu" | "lxc"
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get(`/nodes/${node}/${type}/${vmid}/config`);
    const config = result.data.data || {};

    const normalized = normalizeProxmoxResponse({
      node,
      vmid,
      type,
      ...config,
    });

    return {
      data: normalized,
      metadata: result.metadata,
    };
  }

  /**
   * Get VM network information
   */
  private async getVmNetwork(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    type: "qemu" | "lxc"
  ): Promise<{ data: any; metadata: any }> {
    // Get VM config to extract network interfaces
    const configResult = await client.get(`/nodes/${node}/${type}/${vmid}/config`);
    const config = configResult.data.data || {};

    // Extract network-related config
    const networkConfig: Record<string, any> = {};
    let usesDhcp = false;
    const macs: string[] = [];
    
    for (const [key, value] of Object.entries(config)) {
      if (key.startsWith("net") || key.startsWith("bridge")) {
        networkConfig[key] = value;
        
        // Check if DHCP is being used
        if (typeof value === "string") {
          if (value.includes("ip=dhcp") || value.includes("ip=dhcp,")) {
            usesDhcp = true;
          }
          
          // Extract MAC addresses
          const macMatch = value.match(
            /(?:hwaddr=|virtio=|model=)([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/
          );
          if (macMatch) {
            macs.push(macMatch[1].toLowerCase());
          }
        }
      }
    }

    const normalized = normalizeProxmoxResponse({
      node,
      vmid,
      type,
      network: networkConfig,
    });

    // If DHCP is detected, add guidance to query DHCP leases
    if (usesDhcp) {
      (normalized as any).usesDhcp = true;
      (normalized as any).message = "This VM/container uses DHCP for IP assignment. Query DHCP leases to find the current IP address.";
      (normalized as any).nextAction = {
        tool: "opnsense_readonly",
        action: "dhcp_leases_list",
        reason: "VM/container uses DHCP. Query DHCP leases to find IP address by MAC address or hostname.",
        macAddresses: macs.length > 0 ? macs : undefined,
      };
    }

    return {
      data: normalized,
      metadata: configResult.metadata,
    };
  }

  /**
   * Get VM snapshots
   */
  private async getVmSnapshots(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    type: "qemu" | "lxc"
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get(`/nodes/${node}/${type}/${vmid}/snapshot`);
    const snapshots = result.data.data || [];

    const normalized = snapshots.map((snapshot: any) =>
      normalizeProxmoxResponse({
        name: snapshot.name,
        description: snapshot.description,
        parent: snapshot.parent,
        snaptime: snapshot.snaptime,
        vmstate: snapshot.vmstate,
      })
    );

    return {
      data: { node, vmid, type, snapshots: normalized, count: normalized.length },
      metadata: result.metadata,
    };
  }

  /**
   * Get VM IP addresses via guest agent
   * Falls back to config-based methods if guest agent unavailable
   */
  /**
   * Extract static IP addresses from network config
   */
  private extractStaticIPs(config: Record<string, any>): string[] {
    const staticIPs: string[] = [];
    for (const [key, value] of Object.entries(config)) {
      if ((key.startsWith("net") || key.startsWith("ip")) && typeof value === "string") {
        // Match patterns like: ip=192.168.1.1/24, ip=10.0.0.1/8, etc.
        const staticIPMatch = value.match(/ip=([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:\/[0-9]{1,2})?)/);
        if (staticIPMatch && !value.includes("ip=dhcp")) {
          staticIPs.push(staticIPMatch[1].split("/")[0]); // Extract IP without CIDR
        }
      }
    }
    return staticIPs;
  }

  /**
   * Extract hostname from config
   */
  private extractHostname(config: Record<string, any>): string | null {
    // Check common hostname fields
    if (config.hostname && typeof config.hostname === "string") {
      return config.hostname;
    }
    if (config.name && typeof config.name === "string") {
      return config.name;
    }
    // For LXC, hostname might be in searchdomain or other fields
    if (config.searchdomain && typeof config.searchdomain === "string") {
      // Sometimes hostname is combined with searchdomain
      const parts = config.searchdomain.split(".");
      if (parts.length > 0) {
        return parts[0];
      }
    }
    return null;
  }

  /**
   * Resolve hostname via DNS
   */
  private async resolveDNS(hostname: string, domains: string[] = [".prox", ".local", ""]): Promise<string[]> {
    const resolvedIPs: string[] = [];
    
    for (const domain of domains) {
      const fqdn = domain ? `${hostname}${domain}` : hostname;
      try {
        const addresses = await dns.resolve4(fqdn);
        resolvedIPs.push(...addresses);
        pceLogger.debug("DNS resolution successful", { fqdn, addresses });
      } catch (error: any) {
        // DNS resolution failed, try next domain
        pceLogger.debug("DNS resolution failed", { fqdn, error: error.message });
      }
    }
    
    return [...new Set(resolvedIPs)]; // Remove duplicates
  }

  private async getVmIP(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    type: "qemu" | "lxc"
  ): Promise<{ data: any; metadata: any }> {
    // Check VM status first to determine if IP is current or historical
    let vmStatus: string | null = null;
    try {
      const statusResult = await this.getVmStatus(client, node, vmid, type);
      vmStatus = statusResult.data?.status || null;
    } catch (statusError: any) {
      // Status check failed, continue anyway
      pceLogger.debug("Failed to get VM status for IP lookup", { node, vmid, error: statusError.message });
    }

    const isOffline = vmStatus === "stopped" || vmStatus === null;

    // Get config for static IP detection and DNS resolution (works for both qemu and lxc)
    let config: Record<string, any> = {};
    let configResult: any = null;
    try {
      configResult = await client.get(`/nodes/${node}/${type}/${vmid}/config`);
      config = configResult.data.data || {};
    } catch (configError: any) {
      pceLogger.debug("Failed to get config for IP discovery", { node, vmid, type, error: configError.message });
    }

    // Extract static IPs from config
    const staticIPs = this.extractStaticIPs(config);
    
    // Extract hostname and try DNS resolution
    const hostname = this.extractHostname(config);
    let dnsIPs: string[] = [];
    if (hostname) {
      try {
        dnsIPs = await this.resolveDNS(hostname, [".prox", ".local", ""]);
      } catch (dnsError: any) {
        pceLogger.debug("DNS resolution failed", { hostname, error: dnsError.message });
      }
    }

    // Extract MAC addresses for DHCP fallback
    const macs: string[] = [];
    for (const [key, value] of Object.entries(config)) {
      if ((key.startsWith("net") || key.startsWith("bridge")) && typeof value === "string") {
        const macMatch = value.match(
          /(?:hwaddr=|virtio=|model=)([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/
        );
        if (macMatch) {
          macs.push(macMatch[1].toLowerCase());
        }
      }
    }

    // Combine all discovered IPs
    const allIPs = [...new Set([...staticIPs, ...dnsIPs])];
    const sources: string[] = [];
    if (staticIPs.length > 0) sources.push("static_config");
    if (dnsIPs.length > 0) sources.push("dns_resolution");

    // Only qemu VMs support guest agent
    if (type !== "qemu") {
      // For LXC containers, return what we found from config/DNS
      return {
        data: {
          node,
          vmid,
          type,
          status: vmStatus,
          ips: allIPs,
          staticIPs: staticIPs.length > 0 ? staticIPs : undefined,
          dnsIPs: dnsIPs.length > 0 ? dnsIPs : undefined,
          hostname: hostname || undefined,
          macs: macs.length > 0 ? macs : undefined,
          source: sources.length > 0 ? sources.join("+") : "lxc_config",
          ...(allIPs.length === 0 && {
            message: "LXC containers don't support guest agent. No static IPs found in config and DNS resolution failed. Use opnsense_readonly with action 'dhcp_leases_list' to find IP by MAC address or hostname.",
            suggestion: "Query DHCP leases using opnsense_readonly tool with action 'dhcp_leases_list' to find the IP address",
            nextAction: {
              tool: "opnsense_readonly",
              action: "dhcp_leases_list",
              reason: "LXC containers use DHCP. Query DHCP leases to find IP address by MAC address or hostname.",
              macAddresses: macs.length > 0 ? macs : undefined,
              hostname: hostname || undefined,
            },
          }),
          ...(isOffline && allIPs.length === 0 && { 
            note: "VM is currently offline. Any IP address found via DHCP will be historical (last known IP from DHCP lease)." 
          }),
        },
        metadata: configResult?.metadata || { timestamp: Date.now(), durationMs: 0 },
      };
    }

    try {
      // Try guest agent first
      const agentResult = await client.get(
        `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`
      );
      const interfaces = agentResult.data.data?.result || [];

      const ips: string[] = [];
      const interfacesData: Array<{
        name: string;
        ips: string[];
        mac?: string;
      }> = [];

      for (const iface of interfaces) {
        const ifaceIPs: string[] = [];
        if (iface["ip-addresses"] && Array.isArray(iface["ip-addresses"])) {
          for (const ip of iface["ip-addresses"]) {
            if (
              ip["ip-address-type"] === "ipv4" &&
              !ip["ip-address"].startsWith("127.")
            ) {
              ips.push(ip["ip-address"]);
              ifaceIPs.push(ip["ip-address"]);
            }
          }
        }
        if (ifaceIPs.length > 0 || iface.name) {
          interfacesData.push({
            name: iface.name || "unknown",
            ips: ifaceIPs,
            mac: iface["hardware-address"],
          });
        }
      }

      // Also check for static IPs and DNS IPs as additional info
      // (Config was already fetched above)
      const staticIPs = this.extractStaticIPs(config);
      const hostname = this.extractHostname(config);
      let dnsIPs: string[] = [];
      if (hostname) {
        try {
          dnsIPs = await this.resolveDNS(hostname, [".prox", ".local", ""]);
        } catch (dnsError: any) {
          // DNS resolution failed, ignore
        }
      }

      // Combine guest agent IPs with any additional IPs from config/DNS
      const allIPs = [...new Set([...ips, ...staticIPs, ...dnsIPs])];
      const additionalSources: string[] = [];
      if (staticIPs.length > 0 && !ips.some(ip => staticIPs.includes(ip))) {
        additionalSources.push("static_config");
      }
      if (dnsIPs.length > 0 && !ips.some(ip => dnsIPs.includes(ip))) {
        additionalSources.push("dns_resolution");
      }

      return {
        data: {
          node,
          vmid,
          type,
          status: vmStatus,
          ips: allIPs,
          guestAgentIPs: ips,
          ...(staticIPs.length > 0 && { staticIPs }),
          ...(dnsIPs.length > 0 && { dnsIPs }),
          ...(hostname && { hostname }),
          interfaces: interfacesData,
          source: additionalSources.length > 0 ? `guest_agent+${additionalSources.join("+")}` : "guest_agent",
          ...(isOffline && { 
            note: "VM is currently offline. IP addresses shown are from the last time the guest agent was accessible." 
          }),
        },
        metadata: agentResult.metadata,
      };
    } catch (error: any) {
      // Guest agent not available, try fallback methods
      pceLogger.debug("Guest agent not available, trying fallback methods", {
        node,
        vmid,
        error: error.message,
      });

      // Fallback: Use config-based methods (static IPs, DNS, MACs for DHCP)
      // Config was already fetched above, so use it
      return {
        data: {
          node,
          vmid,
          type,
          status: vmStatus,
          ips: allIPs,
          staticIPs: staticIPs.length > 0 ? staticIPs : undefined,
          dnsIPs: dnsIPs.length > 0 ? dnsIPs : undefined,
          hostname: hostname || undefined,
          macs: macs.length > 0 ? macs : undefined,
          source: sources.length > 0 ? sources.join("+") : "config_fallback",
          ...(allIPs.length === 0 && {
            message:
              "Guest agent unavailable. No static IPs found in config and DNS resolution failed. IP resolution requires DHCP query or guest agent.",
            suggestion: "Query DHCP leases using opnsense_readonly tool with action 'dhcp_leases_list' to find IP by MAC address or hostname",
            nextAction: {
              tool: "opnsense_readonly",
              action: "dhcp_leases_list",
              reason: "Guest agent unavailable. Query DHCP leases to find IP address by MAC address or hostname.",
              macAddresses: macs.length > 0 ? macs : undefined,
              hostname: hostname || undefined,
            },
          }),
          ...(isOffline && allIPs.length === 0 && { 
            note: "VM is currently offline. Any IP address found via DHCP will be historical (last known IP from DHCP lease)." 
          }),
        },
        metadata: configResult?.metadata || { timestamp: Date.now(), durationMs: 0 },
      };
    }
  }

  /**
   * Get LXC container configuration
   */
  private async getLxcConfig(
    client: ProxmoxClient,
    node: string,
    vmid: number
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get(`/nodes/${node}/lxc/${vmid}/config`);
    const config = result.data.data || {};

    const normalized = normalizeProxmoxResponse({
      node,
      vmid,
      type: "lxc",
      ...config,
    });

    return {
      data: normalized,
      metadata: result.metadata,
    };
  }

  // ==================== Cluster-Level Actions ====================

  /**
   * Get cluster resources (all nodes, VMs, storage)
   */
  private async getClusterResources(
    client: ProxmoxClient
  ): Promise<{ data: any; metadata: any }> {
    // Get both VMs (qemu) and containers (lxc) - don't filter by type to get everything
    const result = await client.get("/cluster/resources");
    const allResources = result.data.data || [];
    
    // Filter to only VMs and containers (exclude nodes, storage, etc.)
    const resources = allResources.filter((r: any) => r.type === "qemu" || r.type === "lxc");

    const normalized = resources.map((resource: any) =>
      normalizeProxmoxResponse({
        id: resource.id,
        type: resource.type,
        node: resource.node,
        name: resource.name,
        status: resource.status,
        cpu: resource.cpu,
        mem: resource.mem,
        maxmem: resource.maxmem,
        maxdisk: resource.maxdisk,
        disk: resource.disk,
        uptime: resource.uptime,
        vmid: resource.vmid,
      })
    );

    return {
      data: { resources: normalized, count: normalized.length },
      metadata: result.metadata,
    };
  }

  /**
   * Get cluster status
   */
  private async getClusterStatus(
    client: ProxmoxClient
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get("/cluster/status");
    const status = result.data.data || [];

    // Separate different status types
    const quorum = status.find((s: any) => s.type === "quorum") || {};
    const nodes = status.filter((s: any) => s.type === "node") || [];

    const normalized = normalizeProxmoxResponse({
      quorum: {
        quorate: quorum.quorate,
        votes: quorum.votes,
        expected_votes: quorum.expected_votes,
      },
      nodes: nodes.map((node: any) => ({
        name: node.name,
        nodeid: node.nodeid,
        online: node.online,
        local: node.local,
      })),
    });

    return {
      data: normalized,
      metadata: result.metadata,
    };
  }

  /**
   * Get Ceph status (if Ceph is configured)
   */
  private async getClusterCephStatus(
    client: ProxmoxClient
  ): Promise<{ data: any; metadata: any }> {
    try {
      const result = await client.get("/cluster/ceph/status");
      const status = result.data.data || {};

      const normalized = normalizeProxmoxResponse({
        health: status.health,
        time: status.time,
        ...status,
      });

      return {
        data: normalized,
        metadata: result.metadata,
      };
    } catch (error: any) {
      // Ceph might not be configured, return empty status
      if (error.response?.status === 404 || error.response?.status === 400) {
        return {
          data: { configured: false, message: "Ceph is not configured on this cluster" },
          metadata: { status: 404, timestamp: Date.now(), durationMs: 0 },
        };
      }
      throw error;
    }
  }

  /**
   * Get HA groups
   */
  private async getHaGroups(
    client: ProxmoxClient
  ): Promise<{ data: any; metadata: any }> {
    try {
      const result = await client.get("/cluster/ha/groups");
      const groups = result.data.data || [];

      const normalized = groups.map((group: any) =>
        normalizeProxmoxResponse({
          group: group.group,
          nodes: group.nodes,
          nofailback: group.nofailback,
          restricted: group.restricted,
        })
      );

      return {
        data: { groups: normalized, count: normalized.length },
        metadata: result.metadata,
      };
    } catch (error: any) {
      // HA might not be configured
      if (error.response?.status === 404 || error.response?.status === 400) {
        return {
          data: { configured: false, groups: [], count: 0, message: "HA is not configured on this cluster" },
          metadata: { status: 404, timestamp: Date.now(), durationMs: 0 },
        };
      }
      throw error;
    }
  }

  /**
   * Get HA resources
   */
  private async getHaResources(
    client: ProxmoxClient
  ): Promise<{ data: any; metadata: any }> {
    try {
      const result = await client.get("/cluster/ha/resources");
      const resources = result.data.data || [];

      const normalized = resources.map((resource: any) =>
        normalizeProxmoxResponse({
          sid: resource.sid,
          type: resource.type,
          group: resource.group,
          state: resource.state,
          status: resource.status,
          comment: resource.comment,
        })
      );

      return {
        data: { resources: normalized, count: normalized.length },
        metadata: result.metadata,
      };
    } catch (error: any) {
      // HA might not be configured
      if (error.response?.status === 404 || error.response?.status === 400) {
        return {
          data: { configured: false, resources: [], count: 0, message: "HA is not configured on this cluster" },
          metadata: { status: 404, timestamp: Date.now(), durationMs: 0 },
        };
      }
      throw error;
    }
  }
}

