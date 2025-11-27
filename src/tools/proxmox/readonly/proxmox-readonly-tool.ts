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
 * Supports 18 distinct read-only actions across Nodes, VMs, Cluster, and System
 */
export const ProxmoxReadOnlyParams = z.object({
  action: z
    .enum([
      // Node-Level (7 actions)
      "list_nodes",
      "node_status",
      "node_storage",
      "node_services",
      "node_tasks",
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

      // System-Level (1 action)
      "get_version",
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

  override getSchema(): ToolSchema {
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
          description: "List storage on a node",
          parameters: { action: "node_storage", node: "pve1" },
        },
        {
          description: "List services on a node",
          parameters: { action: "node_services", node: "pve1" },
        },
        {
          description: "List tasks on a node",
          parameters: { action: "node_tasks", node: "pve1" },
        },
        {
          description: "Get Proxmox version",
          parameters: { action: "get_version" },
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
          description: "Get VM IP address via guest agent (requires guest agent enabled and VM.Monitor + VM.Audit permissions)",
          parameters: { action: "get_vm_ip", node: "YANG", vmid: 211, type: "qemu" },
        },
        {
          description: "Get LXC container configuration",
          parameters: { action: "get_lxc_config", node: "YANG", vmid: 100 },
        },
      ],
      notes: [
        "All operations are strictly read-only. Write operations will return OPERATION_FORBIDDEN error.",
        "All responses are structured JSON objects with normalized data (memory in MB/GB, timestamps in ISO8601).",
        "get_vm_ip requires guest agent enabled in VM config and API token with VM.Monitor + VM.Audit permissions. Returns 403 if permissions insufficient or guest agent unavailable.",
        "Internal IP addresses, MAC addresses, and credentials are automatically sanitized from responses.",
      ],
    });
  }

  override getParameterSchema() {
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
    // System-level actions (no node required)
    if (action === "get_version") {
      return this.handleSystemAction(action, params, client);
    }

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
        // Normalize node name and add hint if changed
        const originalNodeStatus = params.node;
        const normalizedNodeStatus = await this.normalizeNodeName(client, params.node);
        const statusResult = await this.getNodeStatus(client, normalizedNodeStatus);
        if (originalNodeStatus !== normalizedNodeStatus) {
          statusResult.data._hint = `Note: Node name "${originalNodeStatus}" was normalized to "${normalizedNodeStatus}". For future queries, use the exact node name "${normalizedNodeStatus}" or call "list_nodes" first to see available nodes.`;
        }
        return statusResult;

      case "node_storage":
        if (!params.node) {
          throw new Error("node parameter required for node_storage");
        }
        const originalNodeStorage = params.node;
        const normalizedNodeStorage = await this.normalizeNodeName(client, params.node);
        const activeClientStorage = this.apiClient || client;
        const storageResult = await this.getNodeStorage(activeClientStorage, normalizedNodeStorage);
        if (originalNodeStorage !== normalizedNodeStorage) {
          storageResult.data._hint = `Note: Node name "${originalNodeStorage}" was normalized to "${normalizedNodeStorage}". For future queries, use the exact node name "${normalizedNodeStorage}" or call "list_nodes" first to see available nodes.`;
        }
        return storageResult;

      case "node_services":
        if (!params.node) {
          throw new Error("node parameter required for node_services");
        }
        const originalNodeServices = params.node;
        const normalizedNodeServices = await this.normalizeNodeName(client, params.node);
        const activeClientServices = this.apiClient || client;
        const servicesResult = await this.getNodeServices(activeClientServices, normalizedNodeServices);
        if (originalNodeServices !== normalizedNodeServices) {
          servicesResult.data._hint = `Note: Node name "${originalNodeServices}" was normalized to "${normalizedNodeServices}". For future queries, use the exact node name "${normalizedNodeServices}" or call "list_nodes" first to see available nodes.`;
        }
        return servicesResult;

      case "node_tasks":
        if (!params.node) {
          throw new Error("node parameter required for node_tasks");
        }
        const originalNodeTasks = params.node;
        const normalizedNodeTasks = await this.normalizeNodeName(client, params.node);
        const activeClientTasks = this.apiClient || client;
        const tasksResult = await this.getNodeTasks(activeClientTasks, normalizedNodeTasks);
        if (originalNodeTasks !== normalizedNodeTasks) {
          tasksResult.data._hint = `Note: Node name "${originalNodeTasks}" was normalized to "${normalizedNodeTasks}". For future queries, use the exact node name "${normalizedNodeTasks}" or call "list_nodes" first to see available nodes.`;
        }
        return tasksResult;

      case "node_disks":
        if (!params.node) {
          throw new Error("node parameter required for node_disks");
        }
        const originalNodeDisks = params.node;
        const normalizedNodeDisks = await this.normalizeNodeName(client, params.node);
        const activeClientDisks = this.apiClient || client;
        const disksResult = await this.getNodeDisks(activeClientDisks, normalizedNodeDisks);
        if (originalNodeDisks !== normalizedNodeDisks) {
          disksResult.data._hint = `Note: Node name "${originalNodeDisks}" was normalized to "${normalizedNodeDisks}". For future queries, use the exact node name "${normalizedNodeDisks}" or call "list_nodes" first to see available nodes.`;
        }
        return disksResult;

      case "node_network_interfaces":
        if (!params.node) {
          throw new Error("node parameter required for node_network_interfaces");
        }
        const originalNodeNetwork = params.node;
        const normalizedNodeNetwork = await this.normalizeNodeName(client, params.node);
        const activeClientNetwork = this.apiClient || client;
        const networkResult = await this.getNodeNetworkInterfaces(activeClientNetwork, normalizedNodeNetwork);
        if (originalNodeNetwork !== normalizedNodeNetwork) {
          networkResult.data._hint = `Note: Node name "${originalNodeNetwork}" was normalized to "${normalizedNodeNetwork}". For future queries, use the exact node name "${normalizedNodeNetwork}" or call "list_nodes" first to see available nodes.`;
        }
        return networkResult;

      case "list_vms":
        // If node is not provided, use cluster_resources to list all VMs across the cluster
        if (!params.node) {
          return this.listVmsFromCluster(client, params.type);
        }
        // Normalize node name and capture original for hint
        // normalizeNodeName may switch to an alternative cluster, updating this.apiClient
        const originalNodeName = params.node;
        const normalizedNode = await this.normalizeNodeName(client, params.node);
        
        // Use the updated client if it was switched to an alternative cluster
        const activeClient = this.apiClient || client;
        
        // Try node-specific list first, but fallback to cluster_resources if it fails
        try {
          // If no type specified, query both qemu and lxc
          if (!params.type) {
            const result = await this.listVmsBothTypes(activeClient, normalizedNode);
            // Add hint if node name was normalized
            if (originalNodeName !== normalizedNode) {
              result.data._hint = `Note: Node name "${originalNodeName}" was normalized to "${normalizedNode}". For future queries, use the exact node name "${normalizedNode}" or call "list_nodes" first to see available nodes.`;
            }
            return result;
          }
          const result = await this.listVms(activeClient, normalizedNode, params.type);
          // Add hint if node name was normalized
          if (originalNodeName !== normalizedNode) {
            result.data._hint = `Note: Node name "${originalNodeName}" was normalized to "${normalizedNode}". For future queries, use the exact node name "${normalizedNode}" or call "list_nodes" first to see available nodes.`;
          }
          return result;
        } catch (error: any) {
          // If node-specific list fails (e.g., 403), fallback to cluster_resources filtered by node
          const errorStatus = error?.response?.status || error?.status;
          if (errorStatus === 403 || errorStatus === 404) {
            pceLogger.warn("Node-specific list_vms failed, falling back to cluster_resources", {
              node: normalizedNode,
              originalNode: originalNodeName,
              errorStatus,
            });
            // Use cluster_resources and filter by node (use activeClient which may be from alternative cluster)
            const clusterResult = await this.getClusterResources(activeClient);
            const allResources = clusterResult.data.resources || [];
            const filteredResources = allResources.filter((r: any) => {
              const nodeMatch = r.node?.toLowerCase() === normalizedNode.toLowerCase() ||
                                r.node?.toLowerCase() === originalNodeName.toLowerCase();
              const typeMatch = !params.type || r.type === params.type;
              return nodeMatch && typeMatch && (r.type === "qemu" || r.type === "lxc");
            });
            
            return {
              data: {
                resources: filteredResources,
                node: normalizedNode,
                type: params.type || "all",
                _hint: `Node-specific list failed (${errorStatus}), using cluster_resources filtered by node. If this is incorrect, verify the node name with "list_nodes".`,
                _fallback: true,
              },
              metadata: clusterResult.metadata,
            };
          }
          // Re-throw if it's not a 403/404
          throw error;
        }

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
    // Normalize node name for VM actions too
    // normalizeNodeName may switch to an alternative cluster, updating this.apiClient
    params.node = await this.normalizeNodeName(client, params.node);
    const activeClientVm = this.apiClient || client;
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
        await activeClientVm.get(`/nodes/${params.node}/qemu/${params.vmid}/status/current`);
        vmType = "qemu";
      } catch (error: any) {
        // If qemu fails with 404/403/500, try lxc (500 can indicate wrong type)
        const status = error?.response?.status;
        if (status === 404 || status === 403 || status === 500) {
          try {
            await activeClientVm.get(`/nodes/${params.node}/lxc/${params.vmid}/status/current`);
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
        return this.getVmStatus(activeClientVm, params.node, params.vmid, vmType);

      case "get_vm_config":
        return this.getVmConfig(activeClientVm, params.node, params.vmid, vmType);

      case "get_vm_network":
        return this.getVmNetwork(activeClientVm, params.node, params.vmid, vmType);

      case "get_vm_snapshots":
        return this.getVmSnapshots(activeClientVm, params.node, params.vmid, vmType);

      case "get_vm_ip":
        return this.getVmIP(activeClientVm, params.node, params.vmid, vmType);

      case "get_lxc_config":
        return this.getLxcConfig(activeClientVm, params.node, params.vmid);

      default:
        throw new Error(`Unknown VM action: ${action}`);
    }
  }

  /**
   * Handle system-level actions (no node required)
   */
  private async handleSystemAction(
    action: string,
    params: Record<string, any>,
    client: ProxmoxClient
  ): Promise<{ data: any; metadata: any }> {
    switch (action) {
      case "get_version":
        return this.getVersion(client);

      default:
        throw new Error(`Unknown system action: ${action}`);
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
   * Deterministic node name alias map for common variations
   * Maps common name variations to actual node names
   */
  private static readonly NODE_ALIASES: Record<string, string> = {
    // proxBig variations
    proxbig: "proxBig",
    prox_big: "proxBig",
    "prox-big": "proxBig",
    // YANG variations (case-sensitive - must be uppercase)
    yang: "YANG",
    "yang.prox": "YANG",
    // Add more aliases as needed
  };

  /**
   * Known node → endpoint map so we can query alternate clusters directly.
   * This helps list_nodes discover nodes that live on separate API endpoints.
   */
  private static readonly NODE_ENDPOINT_MAP: Record<string, string> = {
    proxbig: "https://proxBig.prox:8006",
    yin: "https://yin.prox:8006",
    yang: "https://yang.prox:8006",
  };

  private static normalizeNodeKey(name: string): string {
    return name.toLowerCase().replace(/[_-]/g, "");
  }

  /**
   * Normalize node name by validating FIRST, then using fuzzy matching
   * This prevents 403 errors from trying non-existent node names
   * 
   * Strategy:
   * 1. Check deterministic alias map
   * 2. List all nodes from cluster to get actual node names
   * 3. Try exact case-insensitive match
   * 4. Try fuzzy match (ignoring underscores/hyphens/case)
   * 5. Check if it matches PROXMOX_URL hostname (for standalone nodes)
   * 6. Return normalized name or throw helpful error
   */
  private async normalizeNodeName(
    client: ProxmoxClient,
    nodeName: string
  ): Promise<string> {
    // Step 1: Check deterministic alias map first
    const aliasKey = nodeName.toLowerCase().replace(/[_-]/g, '');
    if (ProxmoxReadOnlyTool.NODE_ALIASES[aliasKey]) {
      const aliased = ProxmoxReadOnlyTool.NODE_ALIASES[aliasKey];
      pceLogger.debug(`Node name alias resolved: "${nodeName}" -> "${aliased}"`);
      nodeName = aliased;
    }

    // Step 2: Always validate FIRST by listing nodes (prevents 403s from wrong names)
    try {
      const result = await client.get("/nodes");
      // Handle various response structures defensively
      let nodes: any[] = [];
      if (result?.data?.data) {
        nodes = Array.isArray(result.data.data) ? result.data.data : [];
      } else if (Array.isArray(result?.data)) {
        nodes = result.data;
      }
      
      if (nodes.length === 0) {
        pceLogger.warn("No nodes found in cluster - may be standalone node");
        // Fall through to standalone node check
      } else {
        // Step 3: Try exact case-insensitive match
        let normalized = nodes.find(
          (n: any) => n?.node && n.node.toLowerCase() === nodeName.toLowerCase()
        );
        
        // Step 4: If no exact match, try fuzzy match (ignoring underscores/hyphens)
        if (!normalized) {
          const normalizeForMatch = (name: string) => name.toLowerCase().replace(/[_-]/g, '');
          const searchNormalized = normalizeForMatch(nodeName);
          
          normalized = nodes.find(
            (n: any) => n?.node && normalizeForMatch(n.node) === searchNormalized
          );
        }
        
        if (normalized?.node) {
          pceLogger.debug(`Normalized node name: "${nodeName}" -> "${normalized.node}"`);
          return normalized.node; // Return the actual node name with correct case
        }
      }
    } catch (listError: any) {
      pceLogger.error(`Failed to list nodes for normalization: ${listError.message}`);
      // Fall through to standalone node check
    }

    // Step 5: Check if this might be a standalone/local node by comparing with PROXMOX_URL
    const proxmoxUrl = process.env.PROXMOX_URL;
    if (proxmoxUrl) {
      try {
        const url = new URL(proxmoxUrl);
        const urlHostname = url.hostname.toLowerCase().replace(/\.(prox|local)$/, '');
        const nodeNameLower = nodeName.toLowerCase().replace(/[_-]/g, '');
        const urlNormalized = urlHostname.replace(/[_-]/g, '');
        
        if (urlNormalized === nodeNameLower || 
            urlHostname.includes(nodeNameLower) || 
            nodeNameLower.includes(urlHostname)) {
          pceLogger.debug(`Node "${nodeName}" appears to be the local/standalone node (matches PROXMOX_URL hostname: ${urlHostname})`);
          // Try to get the actual local node name
          try {
            const localResult = await client.get("/nodes");
            // Handle various response structures defensively
            let localNodes: any[] = [];
            if (localResult?.data?.data) {
              localNodes = Array.isArray(localResult.data.data) ? localResult.data.data : [];
            } else if (Array.isArray(localResult?.data)) {
              localNodes = localResult.data;
            }
            if (localNodes.length > 0 && localNodes[0]?.node) {
              const localNode = localNodes[0].node;
              pceLogger.debug(`Using local node name: "${localNode}" for query "${nodeName}"`);
              return localNode;
            }
          } catch (localError: any) {
            pceLogger.debug(`Could not get local nodes list (${localError?.response?.status || localError?.message}), treating "${nodeName}" as standalone node`);
          }
          // If it's the local/standalone node, return it
          pceLogger.debug(`Allowing "${nodeName}" as local/standalone node`);
          return nodeName;
        }
      } catch {
        // URL parsing failed, continue to error
      }
    }

    // Step 6: Node not found in primary cluster - try alternative endpoints
    // Try alternative Proxmox endpoints based on node name (e.g., yin -> yin.prox:8006)
    const alternativeEndpoints = this.getAlternativeEndpoints(nodeName);
    for (const altEndpoint of alternativeEndpoints) {
      try {
        pceLogger.debug(`Trying alternative Proxmox endpoint for node "${nodeName}": ${altEndpoint.url}`);
        // Get credentials - prefer node-specific, fallback to default
        const normalizedNameForCreds = nodeName.toLowerCase().replace(/[_-]/g, '');
        const nodeNameUpper = normalizedNameForCreds.toUpperCase();
        const tokenId = altEndpoint.tokenId || process.env.PROXMOX_TOKEN_ID || this.getApiConfig().tokenId;
        const tokenSecret = altEndpoint.tokenSecret || process.env[`${nodeNameUpper}_TOKEN_SECRET`] || process.env.PROXMOX_TOKEN_SECRET || this.getApiConfig().tokenSecret;
        const verifySsl = this.getApiConfig().verifySsl;
        
        if (!tokenId || !tokenSecret) {
          pceLogger.debug(`Skipping alternative endpoint ${altEndpoint.url}: missing credentials`);
          continue;
        }
        
        const altClient = new ProxmoxClient({
          url: altEndpoint.url,
          tokenId,
          tokenSecret,
          verifySsl,
        });
        
        const result = await altClient.get("/nodes");
        let nodes: any[] = [];
        if (result?.data?.data) {
          nodes = Array.isArray(result.data.data) ? result.data.data : [];
        } else if (Array.isArray(result?.data)) {
          nodes = result.data;
        }
        
        // Try to find the node in this alternative cluster
        const normalizeForMatch = (name: string) => name.toLowerCase().replace(/[_-]/g, '');
        const searchNormalized = normalizeForMatch(nodeName);
        const normalized = nodes.find(
          (n: any) => n?.node && normalizeForMatch(n.node) === searchNormalized
        );
        
        if (normalized?.node) {
          pceLogger.info(`Found node "${nodeName}" in alternative cluster: ${altEndpoint.url} (normalized to "${normalized.node}")`);
          // Update the client to use this endpoint for future requests
          this.apiClient = altClient;
          return normalized.node;
        } else {
          pceLogger.debug(`Node "${nodeName}" not found in alternative cluster ${altEndpoint.url}. Found nodes: ${nodes.map((n: any) => n?.node).filter(Boolean).join(", ") || "none"}`);
        }
      } catch (altError: any) {
        const statusCode = altError?.response?.status;
        pceLogger.debug(`Alternative endpoint ${altEndpoint.url} failed: ${altError.message}${statusCode ? ` (HTTP ${statusCode})` : ''}`);
        // Continue to next endpoint
      }
    }

    // Step 7: Node not found in any cluster - throw helpful error
    try {
      const result = await client.get("/nodes");
      let nodes: any[] = [];
      if (result?.data?.data) {
        nodes = Array.isArray(result.data.data) ? result.data.data : [];
      } else if (Array.isArray(result?.data)) {
        nodes = result.data;
      }
      const availableNodes = nodes.filter((n: any) => n?.node).map((n: any) => n.node).join(", ");
      const errorMsg = `Node "${nodeName}" not found in any accessible cluster. Available nodes in primary cluster: ${availableNodes || "none"}. ` +
        `If "${nodeName}" is in a different cluster, ensure the appropriate PROXMOX_URL and credentials are configured. ` +
        `Current PROXMOX_URL: ${proxmoxUrl || "not set"}`;
      pceLogger.warn(errorMsg);
      throw new Error(errorMsg);
    } catch (error: any) {
      // If we can't even list nodes, throw a simpler error
      if (error.message.includes("not found")) {
        throw error;
      }
      throw new Error(`Node "${nodeName}" not found and could not validate against cluster. ${error.message}`);
    }
  }

  /**
   * Get alternative Proxmox endpoints to try when a node isn't found in the primary cluster
   * Returns array of endpoint configs based on node name patterns
   */
  private getAlternativeEndpoints(nodeName: string): Array<{ url: string; tokenId?: string; tokenSecret?: string }> {
    const endpoints: Array<{ url: string; tokenId?: string; tokenSecret?: string }> = [];
    const normalizedName = ProxmoxReadOnlyTool.normalizeNodeKey(nodeName);
    
    const endpoint = ProxmoxReadOnlyTool.NODE_ENDPOINT_MAP[normalizedName];
    if (endpoint) {
      // Try to get node-specific credentials
      const nodeNameUpper = normalizedName.toUpperCase().replace(/[_-]/g, '');
      const tokenId = process.env.PROXMOX_TOKEN_ID || process.env[`${nodeNameUpper}_TOKEN_ID`];
      const tokenSecret = process.env.PROXMOX_TOKEN_SECRET || process.env[`${nodeNameUpper}_TOKEN_SECRET`];
      
      endpoints.push({
        url: endpoint,
        tokenId: tokenId || undefined,
        tokenSecret: tokenSecret || undefined,
      });
    }
    
    return endpoints;
  }

  /**
   * List all nodes in the cluster (across primary + alternative endpoints)
   * Fetches basic node info from /nodes, then enriches with CPU/memory from /nodes/{node}/status
   */
  private async listNodes(client: ProxmoxClient): Promise<{ data: any; metadata: any }> {
    const result = await client.get("/nodes");
    const primaryNodes = Array.isArray(result.data.data) ? result.data.data : [];

    const combinedNodes: any[] = [];
    const seenKeys = new Set<string>();
    const addNodes = (nodes: any[], sourceLabel: string) => {
      for (const node of nodes) {
        if (!node?.node) continue;
        const key = ProxmoxReadOnlyTool.normalizeNodeKey(node.node);
        if (seenKeys.has(key)) {
          continue;
        }
        seenKeys.add(key);
        combinedNodes.push(node);
        pceLogger.debug(`Discovered node "${node.node}" via ${sourceLabel}`);
      }
    };

    const enrichedPrimary = await this.enrichNodesWithStatus(client, primaryNodes);
    addNodes(enrichedPrimary, "primary cluster");

    // Also probe known alternative endpoints so we can include nodes from other hosts/clusters.
    for (const [nodeName, endpointUrl] of Object.entries(ProxmoxReadOnlyTool.NODE_ENDPOINT_MAP)) {
      const normalizedKey = ProxmoxReadOnlyTool.normalizeNodeKey(nodeName);
      if (seenKeys.has(normalizedKey)) {
        continue;
      }

      const alternativeEndpoints = this.getAlternativeEndpoints(nodeName);
      for (const endpoint of alternativeEndpoints) {
        const altClient = this.createClientForEndpoint(endpoint);
        if (!altClient) {
          continue;
        }
        try {
          const altResult = await altClient.get("/nodes");
          const altNodes = Array.isArray(altResult.data?.data) ? altResult.data.data : [];
          if (!altNodes.length) {
            continue;
          }
          const enrichedAlt = await this.enrichNodesWithStatus(altClient, altNodes);
          addNodes(enrichedAlt, endpoint.url);
        } catch (error: any) {
          pceLogger.debug(
            `Alternative endpoint ${endpoint.url} list_nodes failed: ${error?.message || "unknown error"}`
          );
        }
      }
    }

    const normalized = combinedNodes.map((node) => normalizeProxmoxResponse(node));

    return {
      data: { nodes: normalized, count: normalized.length },
      metadata: result.metadata,
    };
  }

  private async enrichNodesWithStatus(client: ProxmoxClient, nodes: any[]): Promise<any[]> {
    const nodeStatusPromises = nodes
      .filter((node): node is { node: string; [key: string]: any } => Boolean(node?.node))
      .map(async (node) => {
        const nodeName = node.node;
        try {
          const statusResult = await client.get(`/nodes/${nodeName}/status`);
          const status = statusResult.data?.data || {};
          return {
            node: nodeName,
            status: node.status || status.status,
            level: node.level,
            cpu: status.cpu,
            maxcpu: status.maxcpu,
            mem: status.mem,
            maxmem: status.maxmem,
            uptime: status.uptime,
          };
        } catch {
          return {
            node: nodeName,
            status: node.status,
            level: node.level,
            cpu: undefined,
            maxcpu: undefined,
            mem: undefined,
            maxmem: undefined,
            uptime: undefined,
          };
        }
      });

    const enriched = await Promise.all(nodeStatusPromises);
    return enriched.filter(Boolean);
  }

  private createClientForEndpoint(
    endpoint: { url: string; tokenId?: string; tokenSecret?: string }
  ): ProxmoxClient | null {
    const baseConfig = this.getApiConfig();
    const tokenId = endpoint.tokenId || baseConfig.tokenId;
    const tokenSecret = endpoint.tokenSecret || baseConfig.tokenSecret;

    if (!endpoint.url || !tokenId || !tokenSecret) {
      pceLogger.debug(
        `Skipping alternative endpoint ${endpoint.url}: missing credentials (tokenId/tokenSecret)`
      );
      return null;
    }

    return new ProxmoxClient({
      url: endpoint.url,
      tokenId,
      tokenSecret,
      verifySsl: baseConfig.verifySsl,
    });
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
   * Get node storage
   */
  private async getNodeStorage(
    client: ProxmoxClient,
    node: string
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get(`/nodes/${node}/storage`);
    const storage = result.data.data || [];

    const normalized = storage.map((s: any) =>
      normalizeProxmoxResponse({
        storage: s.storage,
        type: s.type,
        content: s.content,
        shared: s.shared,
        active: s.active,
        enabled: s.enabled,
        used: s.used,
        avail: s.avail,
        total: s.total,
        used_fraction: s.used_fraction,
      })
    );

    return {
      data: { node, storage: normalized, count: normalized.length },
      metadata: result.metadata,
    };
  }

  /**
   * Get node services
   */
  private async getNodeServices(
    client: ProxmoxClient,
    node: string
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get(`/nodes/${node}/services`);
    const services = result.data.data || [];

    const normalized = services.map((s: any) =>
      normalizeProxmoxResponse({
        name: s.name,
        state: s.state,
        active_state: s.active_state,
        sub_state: s.sub_state,
      })
    );

    return {
      data: { node, services: normalized, count: normalized.length },
      metadata: result.metadata,
    };
  }

  /**
   * Get node tasks
   */
  private async getNodeTasks(
    client: ProxmoxClient,
    node: string
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get(`/nodes/${node}/tasks`);
    const tasks = result.data.data || [];

    const normalized = tasks.map((t: any) =>
      normalizeProxmoxResponse({
        upid: t.upid,
        type: t.type,
        id: t.id,
        user: t.user,
        status: t.status,
        starttime: t.starttime,
        endtime: t.endtime,
        node: t.node,
      })
    );

    return {
      data: { node, tasks: normalized, count: normalized.length },
      metadata: result.metadata,
    };
  }

  /**
   * Get Proxmox version
   */
  private async getVersion(
    client: ProxmoxClient
  ): Promise<{ data: any; metadata: any }> {
    const result = await client.get("/version");
    const version = result.data.data || {};

    const normalized = normalizeProxmoxResponse({
      version: version.version,
      release: version.release,
      repoid: version.repoid,
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

  /**
   * List both QEMU VMs and LXC containers on a node
   */
  private async listVmsBothTypes(
    client: ProxmoxClient,
    node: string
  ): Promise<{ data: any; metadata: any }> {
    const [qemuResult, lxcResult] = await Promise.allSettled([
      this.listVms(client, node, "qemu").catch((error: any) => {
        // Log but don't fail - might be permission issue but other endpoint might work
        if (error?.response?.status === 403) {
          pceLogger.warn(`403 error querying QEMU VMs on ${node} - may be permission issue`);
        }
        // Return error object that can be checked later
        return { data: { vms: [], count: 0 }, metadata: {}, _error: error };
      }),
      this.listVms(client, node, "lxc").catch((error: any) => {
        if (error?.response?.status === 403) {
          pceLogger.warn(`403 error querying LXC containers on ${node} - may be permission issue`);
        }
        return { data: { vms: [], count: 0 }, metadata: {}, _error: error };
      }),
    ]);

    const qemuData = qemuResult.status === "fulfilled" ? qemuResult.value.data : { vms: [], count: 0 };
    const lxcData = lxcResult.status === "fulfilled" ? lxcResult.value.data : { vms: [], count: 0 };

    const allVms = [...(qemuData.vms || []), ...(lxcData.vms || [])];
    
    // Check if both failed with 403
    const qemuError = qemuResult.status === "rejected" 
      ? qemuResult.reason 
      : (qemuResult.status === "fulfilled" && (qemuResult.value as any)._error ? (qemuResult.value as any)._error : null);
    const lxcError = lxcResult.status === "rejected" 
      ? lxcResult.reason 
      : (lxcResult.status === "fulfilled" && (lxcResult.value as any)._error ? (lxcResult.value as any)._error : null);
    
    const has403Error = (qemuError?.response?.status === 403 || lxcError?.response?.status === 403) && allVms.length === 0;
    const both403 = qemuError?.response?.status === 403 && lxcError?.response?.status === 403;

    return {
      data: {
        node,
        vms: allVms,
        qemu: qemuData.vms || [],
        lxc: lxcData.vms || [],
        count: allVms.length,
        qemuCount: qemuData.count || 0,
        lxcCount: lxcData.count || 0,
        ...(has403Error && { 
          error: both403 
            ? `Permission denied (403) when querying ${node}. The API token does not have sufficient permissions to list VMs/containers on this node. Please verify the token has PVEVMAdmin or PVEAdmin role on /nodes/${node}.`
            : `Partial permission denied (403) when querying ${node}. Some endpoints may not be accessible.`,
          qemuError: qemuError?.response?.status === 403 ? "403 Forbidden - insufficient permissions" : undefined,
          lxcError: lxcError?.response?.status === 403 ? "403 Forbidden - insufficient permissions" : undefined,
        }),
      },
      metadata: qemuResult.status === "fulfilled" ? qemuResult.value.metadata : {},
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
          if (macMatch && macMatch[1]) {
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
        if (staticIPMatch && staticIPMatch[1] && !value.includes("ip=dhcp")) {
          const ipPart = staticIPMatch[1].split("/")[0];
          if (ipPart) {
            staticIPs.push(ipPart); // Extract IP without CIDR
          }
        }
      }
    }
    return staticIPs;
  }

  /**
   * Extract hostname from config
   */
  private extractHostname(config: Record<string, any>): string | undefined {
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
      if (parts.length > 0 && parts[0]) {
        return parts[0];
      }
    }
    return undefined;
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
    // First, verify the VM exists by checking cluster resources
    // This avoids 500 errors when VM doesn't exist
    let vmExists = false;
    let actualType: "qemu" | "lxc" | null = null;
    try {
      const resourcesResult = await client.get("/cluster/resources");
      const resources = resourcesResult.data?.data || [];
      
      const vmResource = resources.find((r: any) => 
        r.vmid === vmid && 
        (r.type === "qemu" || r.type === "lxc") &&
        r.node === node
      );
      
      if (vmResource) {
        vmExists = true;
        actualType = vmResource.type as "qemu" | "lxc";
        // Use the actual type from cluster resources
        if (actualType !== type) {
          pceLogger.debug("VM type mismatch, using type from cluster resources", { 
            node, 
            vmid, 
            requestedType: type, 
            actualType 
          });
          type = actualType;
        }
      } else {
        pceLogger.warn("VM not found in cluster resources", { node, vmid, requestedType: type });
        return {
          data: {
            node,
            vmid,
            type,
            status: null,
            ip: null,
            ips: [],
            source: "unknown",
            error: `VM ${vmid} not found on node ${node}`,
            message: `VM/container ${vmid} does not exist on node ${node}. Use 'list-vms' to see available VMs.`,
            resolutionLayers: [],
          },
          metadata: { timestamp: Date.now(), durationMs: 0 },
        };
      }
    } catch (resourcesError: any) {
      // If cluster resources check fails, continue anyway (might be permission issue)
      pceLogger.debug("Failed to check cluster resources, continuing", { 
        node, 
        vmid, 
        error: resourcesError.message 
      });
    }

    // Check VM status to determine if IP is current or historical
    let vmStatus: string | null = null;
    try {
      const statusResult = await this.getVmStatus(client, node, vmid, type);
      vmStatus = statusResult.data?.status || null;
    } catch (statusError: any) {
      // Status check failed, continue anyway
      const statusCode = statusError.response?.status;
      if (statusCode === 500 && !vmExists) {
        // 500 error likely means VM doesn't exist
        pceLogger.warn("VM status check returned 500, VM likely doesn't exist", { 
          node, 
          vmid, 
          type,
          hint: "Use 'list-vms' to verify VM exists"
        });
      } else {
        pceLogger.debug("Failed to get VM status for IP lookup", { 
          node, 
          vmid, 
          error: statusError.message,
          statusCode 
        });
      }
    }

    const isOffline = vmStatus === "stopped" || vmStatus === null;

    // Get config and VM name for all resolution layers
    let config: Record<string, any> = {};
    let configResult: any = null;
    let vmName: string | null = null;
    
    // Try to get config - if it fails with 500, try the other type (qemu vs lxc)
    // Proxmox sometimes returns 500 when the VM type is wrong
    const tryGetConfig = async (tryType: "qemu" | "lxc"): Promise<{ config: Record<string, any>; result: any } | null> => {
      try {
        const result = await client.get(`/nodes/${node}/${tryType}/${vmid}/config`);
        
        // Handle Proxmox API response structure
        // The API returns: { data: { data: {...} } }
        // client.get returns: { data: response.data, metadata: {...} }
        // So result.data is the Proxmox response, and result.data.data is the actual config
        let configData: Record<string, any> = {};
        if (result.data) {
          if (result.data.data) {
            // Standard Proxmox response format
            configData = result.data.data;
          } else if (typeof result.data === 'object' && !Array.isArray(result.data)) {
            // Sometimes the response is already the config object
            configData = result.data;
          }
        }
        
        return { config: configData, result };
      } catch (error: any) {
        return null;
    }
    };
    
    // Try with the specified type first
    const configAttempt = await tryGetConfig(type);
    if (configAttempt) {
      config = configAttempt.config;
      configResult = configAttempt.result;
    } else {
      // If that failed, try the other type (500 errors often mean wrong type)
      const otherType: "qemu" | "lxc" = type === "qemu" ? "lxc" : "qemu";
      const fallbackAttempt = await tryGetConfig(otherType);
      if (fallbackAttempt) {
        config = fallbackAttempt.config;
        configResult = fallbackAttempt.result;
        // Update type since we found it with the other type
        type = otherType;
        pceLogger.debug("Found VM with different type", { node, vmid, originalType: type === "qemu" ? "lxc" : "qemu", actualType: type });
      } else {
        // Both attempts failed
        const lastError = await tryGetConfig(type).catch(e => e);
        const statusCode = lastError?.response?.status;
        const errorMessage = lastError?.response?.data?.message || lastError?.message || "Unknown error";
        
        if (statusCode === 404 || statusCode === 400) {
          pceLogger.debug("VM/container not found", { node, vmid, type, statusCode });
        } else if (statusCode === 500) {
          pceLogger.warn("Proxmox API returned 500 error for config", { 
            node, 
            vmid, 
            type, 
            error: errorMessage,
            hint: "VM may not exist (vmid " + vmid + "), or there may be a Proxmox API issue. Check if VM exists with 'list-vms'."
          });
        } else {
          pceLogger.debug("Failed to get config for IP discovery", { 
            node, 
            vmid, 
            type, 
            statusCode,
            error: errorMessage 
          });
      }
    }
    }
    
    vmName = config.name || config.hostname || config['hostname'] || null;

    // Extract MAC addresses for DHCP fallback
    const macs: string[] = [];
    for (const [key, value] of Object.entries(config)) {
      if ((key.startsWith("net") || key.startsWith("bridge")) && typeof value === "string") {
        const macMatch = value.match(
          /(?:hwaddr=|virtio=|model=)([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})/
        );
        if (macMatch && macMatch[1]) {
          macs.push(macMatch[1].toLowerCase());
        }
      }
    }

    const hostname = this.extractHostname(config);
    const resolutionLayers: Array<{ layer: number; source: string; ip?: string; method: string }> = [];
    let resolvedIP: string | undefined = undefined;
    let finalSource = "unknown";

    // ===== LAYER 1: Proxmox Config (LXC only) =====
    if (type === "lxc" && config) {
      const staticIPs = this.extractStaticIPs(config);
      const firstIP = staticIPs[0];
      if (firstIP) {
        resolvedIP = firstIP;
        finalSource = "proxmox_config";
        resolutionLayers.push({
          layer: 1,
          source: "proxmox_config",
          ip: resolvedIP,
          method: `Extracted static IP from LXC config: ${resolvedIP}`,
        });
      } else {
        resolutionLayers.push({
          layer: 1,
          source: "proxmox_config",
          method: "No static IP found in LXC config (container may use DHCP)",
        });
      }
    } else if (type === "qemu") {
      resolutionLayers.push({
        layer: 1,
        source: "proxmox_config",
        method: "Skipped (QEMU VMs use guest agent, not config static IPs)",
      });
    } else {
      resolutionLayers.push({
        layer: 1,
        source: "proxmox_config",
        method: "Skipped (config not available)",
      });
    }

    // ===== LAYER 2: Guest Agent (QEMU only) =====
    if (type === "qemu" && !resolvedIP) {
      // Check if agent is enabled in config (we already have config from Layer 1)
      const agentEnabled = config.agent === 1 || config.agent === "1" || config.agent === "enabled";
      
      if (!agentEnabled) {
        resolutionLayers.push({
          layer: 2,
          source: "guest_agent",
          method: "Guest agent not enabled in VM config (agent field missing or disabled)",
        });
      } else {
        try {
          // Query guest agent for network interfaces directly
          // Note: /agent/status endpoint does not exist in Proxmox API (returns 501)
          // Valid endpoints: /agent/network-get-interfaces, /agent/ping, /agent/get-osinfo, etc.
          // We go straight to network-get-interfaces which is the correct endpoint
          const agentResult = await client.get(
            `/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`
          );
      const interfaces = agentResult.data.data?.result || [];

          if (!Array.isArray(interfaces) || interfaces.length === 0) {
            resolutionLayers.push({
              layer: 2,
              source: "guest_agent",
              method: "Guest agent responded but no network interfaces found",
            });
          } else {
      for (const iface of interfaces) {
        if (iface["ip-addresses"] && Array.isArray(iface["ip-addresses"])) {
          for (const ip of iface["ip-addresses"]) {
            if (
              ip["ip-address-type"] === "ipv4" &&
              !ip["ip-address"].startsWith("127.")
            ) {
                    resolvedIP = ip["ip-address"];
                    finalSource = "guest_agent";
                    resolutionLayers.push({
                      layer: 2,
                      source: "guest_agent",
                      ip: resolvedIP,
                      method: `Query Proxmox guest agent (interface: ${iface.name || "unknown"})`,
                    });
                    break;
                  }
                }
                if (resolvedIP) break;
              }
            }

            if (!resolvedIP) {
              resolutionLayers.push({
                layer: 2,
                source: "guest_agent",
                method: "Guest agent responded but no valid IPv4 addresses found (only loopback or IPv6)",
          });
        }
      }
        } catch (error: any) {
          const statusCode = error.response?.status;
          const errorData = error.response?.data;
          
          if (statusCode === 403) {
            resolutionLayers.push({
              layer: 2,
              source: "guest_agent",
              method: `Guest agent query failed: Permission denied (403). API token needs 'VM.Monitor' and 'VM.Audit' permissions for guest agent access.`,
            });
          } else if (statusCode === 500) {
            resolutionLayers.push({
              layer: 2,
              source: "guest_agent",
              method: `Guest agent query failed: Server error (500). Guest agent may not be running in the VM or VM may be stopped.`,
            });
          } else if (statusCode === 501) {
            resolutionLayers.push({
              layer: 2,
              source: "guest_agent",
              method: `Guest agent query failed: Feature not implemented (501). This endpoint may not be available on this Proxmox version or the guest agent feature is not enabled.`,
            });
          } else {
            resolutionLayers.push({
              layer: 2,
              source: "guest_agent",
              method: `Guest agent query failed: ${error.message}${statusCode ? ` (HTTP ${statusCode})` : ''}`,
            });
          }
        }
      }
    } else if (type === "lxc") {
      resolutionLayers.push({
        layer: 2,
        source: "guest_agent",
        method: "Skipped (LXC containers don't support guest agent)",
      });
    }

    // ===== LAYER 3: OPNsense DHCP =====
    if (!resolvedIP && macs.length > 0) {
      try {
        // Try to query OPNsense DHCP leases
        const { OpnsenseReadOnlyTool } = await import("../../opnsense/readonly/opnsense-readonly-tool");
        const opnsenseTool = new OpnsenseReadOnlyTool();
        
        const dhcpResult = await opnsenseTool.execute(
          { action: "dhcp_leases_list" },
          { toolName: "opnsense_readonly", startedAt: Date.now() }
        );

        if (!dhcpResult.error && dhcpResult.data) {
          const leases = Array.isArray(dhcpResult.data) 
            ? dhcpResult.data 
            : dhcpResult.data.leases || dhcpResult.data.data || [];

          // Find lease by MAC address
          for (const mac of macs) {
            for (const lease of leases) {
              const leaseMac = (lease.mac || lease.mac_address || "").toLowerCase();
              if (leaseMac === mac.toLowerCase()) {
                resolvedIP = lease.ip || lease.address || lease.ip_address;
                finalSource = "opnsense_dhcp";
                resolutionLayers.push({
                  layer: 3,
                  source: "opnsense_dhcp",
                  ip: resolvedIP,
                  method: `Found in DHCP lease by MAC: ${mac}`,
                });
                break;
              }
            }
            if (resolvedIP) break;
          }

          // Also try by hostname if MAC didn't match (fuzzy matching for case variations)
          if (!resolvedIP && hostname) {
            const searchHostname = hostname.toLowerCase();
            for (const lease of leases) {
              const leaseHostname = (lease.hostname || lease.name || "").toLowerCase();
              // Exact match or contains match (e.g., "windowsvm" matches "WindowsVM")
              if (leaseHostname === searchHostname || 
                  leaseHostname.includes(searchHostname) || 
                  searchHostname.includes(leaseHostname)) {
                resolvedIP = lease.ip || lease.address || lease.ip_address;
                finalSource = "opnsense_dhcp";
                resolutionLayers.push({
                  layer: 3,
                  source: "opnsense_dhcp",
                  ip: resolvedIP,
                  method: `Found in DHCP lease by hostname: ${hostname} (matched: ${lease.hostname || lease.name})`,
                });
                break;
              }
            }
          }
        }

        if (!resolvedIP) {
          resolutionLayers.push({
            layer: 3,
            source: "opnsense_dhcp",
            method: `No matching DHCP lease found (searched by MAC: ${macs.join(", ")}, hostname: ${hostname || "N/A"})`,
          });
        }
    } catch (error: any) {
        resolutionLayers.push({
          layer: 3,
          source: "opnsense_dhcp",
          method: `OPNsense DHCP query failed: ${error.message}`,
        });
      }
    } else if (!resolvedIP) {
      resolutionLayers.push({
        layer: 3,
        source: "opnsense_dhcp",
        method: "Skipped (no MAC addresses found in config)",
      });
    }

    // ===== LAYER 4: Topology Graph =====
    if (!resolvedIP && vmName) {
      let graphStore: any = null;
      try {
        const { Neo4jGraphStore } = await import("../../../pce/kg/indexation/neo4j-client");
        const { GraphQueryInterface } = await import("../../../pce/kg/queries/query-interface");
        
        graphStore = new Neo4jGraphStore();
        
        // Add timeout for connection
        const connectPromise = graphStore.connect();
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Neo4j connection timeout")), 5000)
        );
        
        await Promise.race([connectPromise, timeoutPromise]);
        const queryInterface = new GraphQueryInterface(graphStore);

        // Query graph for host/container by name
        // Attributes are stored as JSON strings in Neo4j, so we search in the string
        let graphResult = await queryInterface.executeQuery(`
          MATCH (n:Entity)
          WHERE (n.type = "Host" OR n.type = "Container" OR n.type = "VM")
            AND (
              toLower(toString(n.attributes)) CONTAINS toLower($name)
              OR toLower(n.id) CONTAINS toLower($name)
            )
          RETURN n
          LIMIT 10
        `, { name: vmName });
        
        // Filter results to find best match (exact hostname/name match preferred)
        if (graphResult.nodes.length > 0) {
          // Parse attributes and find best match
          const matches = graphResult.nodes.map((node: any) => {
            const attrs = typeof node.attributes === 'string' 
              ? JSON.parse(node.attributes) 
              : node.attributes;
            const hostname = (attrs?.hostname || attrs?.name || '').toLowerCase();
            const nodeId = (node.id || '').toLowerCase();
            const searchName = vmName.toLowerCase();
            const hasIP = attrs?.ip && typeof attrs.ip === 'string' && attrs.ip.match(/^\d+\.\d+\.\d+\.\d+$/);
            
            // Score: Higher is better. Prioritize nodes with IPs.
            // 10 = exact match with IP, 5 = exact match without IP, 8 = contains match with IP, 3 = contains match without IP
            let score = 0;
            const isExactMatch = hostname === searchName || nodeId === searchName;
            const isPartialMatch = hostname.includes(searchName) || searchName.includes(hostname) || nodeId.includes(searchName) || searchName.includes(hostname.split('_')[0]) || hostname.split('_')[0] === searchName;
            
            if (isExactMatch) {
              score = hasIP ? 10 : 5;
            } else if (isPartialMatch) {
              score = hasIP ? 8 : 3;
            }
            
            return { node, attrs, score, hostname, nodeId, hasIP };
          }).filter(m => m.score > 0).sort((a, b) => b.score - a.score);
          
          if (matches.length > 0 && matches[0]) {
            graphResult.nodes = [matches[0].node];
          }
        }

        if (graphResult.nodes.length > 0) {
          const entity = graphResult.nodes[0];
          if (entity && entity.attributes) {
            // Parse attributes if stored as JSON string
            const attrs = typeof entity.attributes === 'string' 
              ? JSON.parse(entity.attributes) 
              : entity.attributes;
            const topologyIP = attrs?.ip;
            
            if (topologyIP) {
              // Handle array or single IP
              const ipValue = Array.isArray(topologyIP) ? topologyIP[0] : topologyIP;
              if (typeof ipValue === "string" && ipValue.match(/^\d+\.\d+\.\d+\.\d+$/)) {
                resolvedIP = ipValue;
                finalSource = "topology";
                resolutionLayers.push({
                  layer: 4,
                  source: "topology",
                  ip: resolvedIP,
                  method: `Found in topology graph by name: ${vmName} (matched: ${attrs?.hostname || attrs?.name || entity.id || "unknown"})`,
                });
              }
            }
          }
        }

        if (!resolvedIP) {
          resolutionLayers.push({
            layer: 4,
            source: "topology",
            method: `No IP found in topology graph for: ${vmName}`,
          });
        }
      } catch (error: any) {
        resolutionLayers.push({
          layer: 4,
          source: "topology",
          method: `Topology graph query failed: ${error.message}`,
        });
      } finally {
        // Always close the connection, even on error
        if (graphStore) {
          try {
            await Promise.race([
              graphStore.close(),
              new Promise((_, reject) => setTimeout(() => reject(new Error("Close timeout")), 2000))
            ]).catch(() => {
              // Ignore close errors/timeouts
            });
          } catch (closeError: any) {
            // Ignore close errors
            pceLogger.debug("Failed to close Neo4j connection", { error: closeError.message });
          }
        }
      }
    } else if (!resolvedIP) {
      resolutionLayers.push({
        layer: 4,
        source: "topology",
        method: "Skipped (no VM name available)",
      });
    }

    // Build response with resolution details
    const allIPs = resolvedIP ? [resolvedIP] : [];
    
      return {
        data: {
          node,
          vmid,
          type,
          status: vmStatus,
        name: vmName || undefined,
        ip: resolvedIP || null,
          ips: allIPs,
          hostname: hostname || undefined,
          macs: macs.length > 0 ? macs : undefined,
        source: finalSource,
        resolutionLayers,
        ...(isOffline && { 
          note: "VM is currently offline. IP address may be historical." 
        }),
        ...(!resolvedIP && {
          message: "IP resolution failed through all 4 layers. No IP address found.",
          suggestion: "Check VM configuration, ensure guest agent is enabled (for QEMU), or verify DHCP leases.",
          }),
        },
        metadata: configResult?.metadata || { timestamp: Date.now(), durationMs: 0 },
      };
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
      data: { 
        resources: normalized, 
        count: normalized.length,
        note: "Search is case-sensitive. When searching for a VM/container by name, match the 'name' field exactly. If no exact match is found, check for case variations or partial matches."
      },
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

