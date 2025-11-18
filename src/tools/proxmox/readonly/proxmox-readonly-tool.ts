import { ProxmoxReadOnlyBase } from "./base";
import { z } from "zod";
import type { ToolSchema } from "../../tool-schema";
import { createToolSchema } from "../../tool-helpers";
import type { ExecutionResult, ExecutionContext } from "../../../types/execution";
import { ProxmoxClient } from "../client";
import { normalizeProxmoxResponse } from "./normalization";

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

      // VM-Level (5 actions)
      "list_vms",
      "get_vm_status",
      "get_vm_config",
      "get_vm_network",
      "get_vm_snapshots",

      // Cluster-Level (5 actions)
      "cluster_resources",
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
    if (action.startsWith("get_vm_")) {
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
        if (!params.node) {
          throw new Error("node parameter required for list_vms");
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
      throw new Error("node parameter required for VM actions");
    }
    if (!params.vmid) {
      throw new Error("vmid parameter required for VM actions");
    }

    const vmType = params.type || "qemu";

    switch (action) {
      case "get_vm_status":
        return this.getVmStatus(client, params.node, params.vmid, vmType);

      case "get_vm_config":
        return this.getVmConfig(client, params.node, params.vmid, vmType);

      case "get_vm_network":
        return this.getVmNetwork(client, params.node, params.vmid, vmType);

      case "get_vm_snapshots":
        return this.getVmSnapshots(client, params.node, params.vmid, vmType);

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

    const normalized = normalizeProxmoxResponse({
      node,
      cpu: {
        usage: status.cpu,
        cores: status.maxcpu,
      },
      memory: {
        used: status.mem,
        total: status.maxmem,
        free: status.maxmem - status.mem,
      },
      uptime: status.uptime,
      kversion: status.kversion,
      pveversion: status.pveversion,
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
    for (const [key, value] of Object.entries(config)) {
      if (key.startsWith("net") || key.startsWith("bridge")) {
        networkConfig[key] = value;
      }
    }

    const normalized = normalizeProxmoxResponse({
      node,
      vmid,
      type,
      network: networkConfig,
    });

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

  // ==================== Cluster-Level Actions ====================

  /**
   * Get cluster resources (all nodes, VMs, storage)
   */
  private async getClusterResources(
    client: ProxmoxClient
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get("/cluster/resources", { type: "vm" });
    const resources = result.data.data || [];

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

