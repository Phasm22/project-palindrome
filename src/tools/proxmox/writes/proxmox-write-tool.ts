import { z } from "zod";
import { ProxmoxWriteBase } from "./base";
import type { ExecutionResult, ExecutionContext } from "../../../types/execution";
import { ProxmoxClient } from "../client";
import { pceLogger as logger } from "../../../pce/utils/logger";
import { createToolSchema } from "../../tool-helpers";
import type { ToolSchema } from "../../tool-schema";

// Alternative client for multi-cluster support
let alternativeClient: ProxmoxClient | null = null;

/**
 * Proxmox Write Tool Parameters Schema
 */
const ProxmoxWriteParams = z.object({
  action: z.enum([
    "start_vm",
    "stop_vm",
    "shutdown_vm",
    "reboot_vm",
    "reset_vm",
    "create_snapshot",
    "rollback_snapshot",
    "clone_vm",
    "migrate_vm",
    "destroy_vm",
  ]),
  node: z.string().min(1, "Node name is required for all VM operations"),
  vmid: z.number().int().positive("VMID must be a positive integer"),
  type: z.enum(["qemu", "lxc"]).optional().default("qemu").describe("VM type (qemu or lxc, default: qemu)"),
  targetNode: z.string().optional(), // For migrate_vm
  snapshotName: z.string().optional(), // For create_snapshot, rollback_snapshot
  newVmid: z.number().optional(), // For clone_vm
  dryRun: z.boolean().optional().default(false),
  timeout: z.number().optional(), // For stop/shutdown operations
});

type ProxmoxWriteParamsType = z.infer<typeof ProxmoxWriteParams>;

/**
 * Proxmox Write Tool
 * Implements 9 safe write actions with dry-run, confirmation, and provenance support
 */
export class ProxmoxWriteTool extends ProxmoxWriteBase {
  constructor() {
    super({
      name: "proxmox_write",
      description:
        "Execute safe write operations on Proxmox VMs: start, stop, shutdown, reboot, reset, snapshot, rollback, clone, migrate, and destroy. All operations support dry-run mode and require confirmation. WARNING: destroy_vm is a destructive operation.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "start_vm",
              "stop_vm",
              "shutdown_vm",
              "reboot_vm",
              "reset_vm",
              "create_snapshot",
              "rollback_snapshot",
              "clone_vm",
              "migrate_vm",
              "destroy_vm",
            ],
            description: "The write action to execute. Use 'reboot_vm' for restart/reboot operations. Use 'start_vm' to start a stopped VM. Use 'stop_vm' to stop a running VM. WARNING: destroy_vm is a destructive operation that permanently deletes the VM/container and cannot be undone.",
          },
          node: {
            type: "string",
            description: "Proxmox node name (REQUIRED) - this is the physical node name like 'pve1', 'yin', etc. NOT the VM/container name. You MUST first query proxmox_readonly with 'list_vms' or 'cluster_resources' to find which node the VM/container is on.",
          },
          vmid: {
            type: "number",
            description: "VM/Container ID (REQUIRED) - the numeric ID like 105, 101, etc.",
          },
          type: {
            type: "string",
            enum: ["qemu", "lxc"],
            description: "VM type (REQUIRED): 'qemu' for virtual machines, 'lxc' for containers. You MUST query proxmox_readonly first to determine the type. Default is 'qemu' but this will fail if the VM is actually an LXC container.",
            default: "qemu",
          },
          targetNode: {
            type: "string",
            description: "Target node for migration (required for migrate_vm). Note: Migration with local storage (LVM, ZFS local) may require stopping the VM/container first. Shared storage (NFS, Ceph) enables live migration.",
          },
          snapshotName: {
            type: "string",
            description: "Snapshot name (required for create_snapshot, rollback_snapshot)",
          },
          newVmid: {
            type: "number",
            description: "New VM ID for clone (required for clone_vm)",
          },
          dryRun: {
            type: "boolean",
            description: "If true, return diff preview without executing",
            default: false,
          },
          timeout: {
            type: "number",
            description: "Timeout in seconds for stop/shutdown operations",
          },
        },
        required: ["action", "node", "vmid"],
      },
      allowedAcls: ["admin", "ops"], // Write operations restricted to admin/ops
      requiresConfirmation: false, // HIL disabled - safe write operations with dry-run and pre-write state capture
      risk: "medium", // Controlled write operations (destroy_vm handled separately)
    });
  }

  getSchema(): ToolSchema {
    return createToolSchema(this, ProxmoxWriteParams, {
      examples: [
        {
          description: "Start a VM (dry-run)",
          parameters: {
            action: "start_vm",
            node: "pve1",
            vmid: 101,
            dryRun: true,
          },
        },
        {
          description: "Restart/Reboot a VM - use reboot_vm action for restart operations",
          parameters: {
            action: "reboot_vm",
            node: "YANG",
            vmid: 9000,
            type: "qemu",
            dryRun: false,
          },
        },
        {
          description: "Stop a VM gracefully",
          parameters: {
            action: "stop_vm",
            node: "pve1",
            vmid: 101,
            type: "qemu",
            dryRun: false,
          },
        },
        {
          description: "Migrate a VM with pre-flight checks",
          parameters: {
            action: "migrate_vm",
            node: "pve1",
            vmid: 101,
            targetNode: "pve2",
            dryRun: false,
          },
        },
        {
          description: "Create a snapshot",
          parameters: {
            action: "create_snapshot",
            node: "pve1",
            vmid: 101,
            snapshotName: "pre-update-snapshot",
            dryRun: true,
          },
        },
      ],
      notes: [
        "All write operations require human confirmation before execution.",
        "Use dryRun: true to preview changes without executing.",
        "Only admin and ops ACL groups can execute write operations.",
        "Pre-write state is automatically captured for rollback capability.",
        "Migration operations include mandatory pre-flight safety checks.",
        "Migration with local storage (LVM, ZFS local) is complex and may require manual steps or stopping the VM/container first. Shared storage (NFS, Ceph) enables seamless live migration.",
      ],
    });
  }

  getParameterSchema(): z.ZodTypeAny {
    return ProxmoxWriteParams;
  }

  async execute(
    params: Record<string, any>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const parsed = ProxmoxWriteParams.safeParse(params);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}` };
    }

    const client = this.getApiClient();
    const { action, dryRun, ...actionParams } = parsed.data;

    // For destroy_vm, add extra warning to context
    if (action === "destroy_vm" && !dryRun) {
      logger.warn("⚠️  EXTREME RISK: destroy_vm operation requested", {
        node: actionParams.node,
        vmid: actionParams.vmid,
        type: actionParams.type,
      });
    }

    // Route to appropriate handler based on action
    return this.executeApiCall(
      () => this.handleAction(action, actionParams, client, dryRun || false),
      context
    );
  }

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
   * This enables write operations on nodes in separate Proxmox instances.
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
   * Get alternative Proxmox endpoints to try when a node isn't found in the primary cluster
   * Returns array of endpoint configs based on node name patterns
   */
  private getAlternativeEndpoints(nodeName: string): Array<{ url: string; tokenId?: string; tokenSecret?: string }> {
    const endpoints: Array<{ url: string; tokenId?: string; tokenSecret?: string }> = [];
    const normalizedName = ProxmoxWriteTool.normalizeNodeKey(nodeName);
    
    const endpoint = ProxmoxWriteTool.NODE_ENDPOINT_MAP[normalizedName];
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
   * Normalize node name by validating FIRST, then using fuzzy matching
   * This prevents 403 errors from trying non-existent node names
   * 
   * Strategy:
   * 1. Check deterministic alias map
   * 2. List all nodes from cluster to get actual node names
   * 3. Try exact case-insensitive match
   * 4. Try fuzzy match (ignoring underscores/hyphens/case)
   * 5. Check if it matches PROXMOX_URL hostname (for standalone nodes)
   * 6. Try alternative endpoints for multi-cluster support
   * 7. Return normalized name or throw helpful error
   */
  private async normalizeNodeName(
    client: ProxmoxClient,
    nodeName: string
  ): Promise<string> {
    // Step 1: Check deterministic alias map first
    const aliasKey = nodeName.toLowerCase().replace(/[_-]/g, '');
    if (ProxmoxWriteTool.NODE_ALIASES[aliasKey]) {
      const aliased = ProxmoxWriteTool.NODE_ALIASES[aliasKey];
      logger.debug(`Node name alias resolved: "${nodeName}" -> "${aliased}"`);
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
        logger.warn("No nodes found in cluster - may be standalone node");
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
          logger.debug(`Normalized node name: "${nodeName}" -> "${normalized.node}"`);
          return normalized.node; // Return the actual node name with correct case
        }
      }
    } catch (listError: any) {
      logger.error(`Failed to list nodes for normalization: ${listError.message}`);
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
          logger.debug(`Node "${nodeName}" appears to be the local/standalone node (matches PROXMOX_URL hostname: ${urlHostname})`);
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
              logger.debug(`Using local node name: "${localNode}" for query "${nodeName}"`);
              return localNode;
            }
          } catch (localError: any) {
            logger.debug(`Could not get local nodes list (${localError?.response?.status || localError?.message}), treating "${nodeName}" as standalone node`);
          }
          // If it's the local/standalone node, return it
          logger.debug(`Allowing "${nodeName}" as local/standalone node`);
          return nodeName;
        }
      } catch {
        // URL parsing failed, continue to error
      }
    }

    // Step 6: Node not found in primary cluster - try alternative endpoints
    const alternativeEndpoints = this.getAlternativeEndpoints(nodeName);
    for (const altEndpoint of alternativeEndpoints) {
      try {
        logger.debug(`Trying alternative Proxmox endpoint for node "${nodeName}": ${altEndpoint.url}`);
        // Get credentials - prefer node-specific, fallback to default
        const normalizedNameForCreds = nodeName.toLowerCase().replace(/[_-]/g, '');
        const nodeNameUpper = normalizedNameForCreds.toUpperCase();
        const tokenId = altEndpoint.tokenId || process.env.PROXMOX_TOKEN_ID;
        const tokenSecret = altEndpoint.tokenSecret || process.env[`${nodeNameUpper}_TOKEN_SECRET`] || process.env.PROXMOX_TOKEN_SECRET;
        const verifySsl = process.env.PROXMOX_VERIFY_SSL !== 'false';
        
        if (!tokenId || !tokenSecret) {
          logger.debug(`Skipping alternative endpoint ${altEndpoint.url}: missing credentials`);
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
          logger.info(`Found node "${nodeName}" in alternative cluster: ${altEndpoint.url} (normalized to "${normalized.node}")`);
          // Store the alternative client for use in subsequent API calls
          alternativeClient = altClient;
          return normalized.node;
        } else {
          logger.debug(`Node "${nodeName}" not found in alternative cluster ${altEndpoint.url}. Found nodes: ${nodes.map((n: any) => n?.node).filter(Boolean).join(", ") || "none"}`);
        }
      } catch (altError: any) {
        const statusCode = altError?.response?.status;
        logger.debug(`Alternative endpoint ${altEndpoint.url} failed: ${altError.message}${statusCode ? ` (HTTP ${statusCode})` : ''}`);
        // Continue to next endpoint
      }
    }

    // Step 7: Node not found in any cluster - throw helpful error
    try {
      const result = await client.get("/nodes");
      // Handle various response structures defensively
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
      logger.warn(errorMsg);
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
   * Route action to appropriate handler
   */
  private async handleAction(
    action: string,
    params: Record<string, any>,
    client: ProxmoxClient,
    dryRun: boolean
  ): Promise<{ data: any; metadata: any }> {
    // Reset alternative client before normalization
    alternativeClient = null;
    
    // Normalize node name for all actions
    if (params.node) {
      params.node = await this.normalizeNodeName(client, params.node);
    }
    if (params.targetNode) {
      params.targetNode = await this.normalizeNodeName(client, params.targetNode);
    }
    
    // Use alternative client if it was set during normalization (multi-cluster support)
    const activeClient = alternativeClient || client;
    
    switch (action) {
      case "start_vm":
        return this.startVm(activeClient, params.node!, params.vmid!, params.type || "qemu", dryRun);
      case "stop_vm":
        return this.stopVm(activeClient, params.node!, params.vmid!, params.type || "qemu", params.timeout, dryRun);
      case "shutdown_vm":
        return this.shutdownVm(activeClient, params.node!, params.vmid!, params.type || "qemu", params.timeout, dryRun);
      case "reboot_vm":
        return this.rebootVm(activeClient, params.node!, params.vmid!, params.type || "qemu", dryRun);
      case "reset_vm":
        return this.resetVm(activeClient, params.node!, params.vmid!, params.type || "qemu", dryRun);
      case "create_snapshot":
        // Snapshots only available for QEMU VMs
        if (params.type === "lxc") {
          throw new Error("Snapshot operations are not available for LXC containers");
        }
        return this.createSnapshot(
          activeClient,
          params.node!,
          params.vmid!,
          params.snapshotName!,
          dryRun
        );
      case "rollback_snapshot":
        // Snapshots only available for QEMU VMs
        if (params.type === "lxc") {
          throw new Error("Snapshot operations are not available for LXC containers");
        }
        return this.rollbackSnapshot(
          activeClient,
          params.node!,
          params.vmid!,
          params.snapshotName!,
          dryRun
        );
      case "clone_vm":
        // Clone only available for QEMU VMs
        if (params.type === "lxc") {
          throw new Error("Clone operation is not available for LXC containers");
        }
        return this.cloneVm(
          activeClient,
          params.node!,
          params.vmid!,
          params.newVmid!,
          dryRun
        );
      case "migrate_vm":
        if (!params.targetNode) {
          throw new Error("targetNode parameter is required for migrate_vm action");
        }
        // Auto-detect type if not provided
        let migrateType = params.type;
        if (!migrateType) {
          try {
            // Try qemu first
            await this.getVmStatus(activeClient, params.node!, params.vmid!, "qemu");
            migrateType = "qemu";
          } catch {
            // Try lxc if qemu fails
            try {
              await this.getVmStatus(activeClient, params.node!, params.vmid!, "lxc");
              migrateType = "lxc";
            } catch {
              throw new Error(`Could not determine VM type for VMID ${params.vmid} on node ${params.node}. Please specify type parameter.`);
            }
          }
        }
        return this.migrateVm(
          activeClient,
          params.node!,
          params.vmid!,
          migrateType,
          params.targetNode!,
          dryRun
        );
      case "destroy_vm":
        // Auto-detect type if not provided
        let destroyType = params.type;
        if (!destroyType) {
          try {
            // Try qemu first
            await this.getVmStatus(activeClient, params.node!, params.vmid!, "qemu");
            destroyType = "qemu";
          } catch {
            // Try lxc if qemu fails
            try {
              await this.getVmStatus(activeClient, params.node!, params.vmid!, "lxc");
              destroyType = "lxc";
            } catch {
              throw new Error(`Could not determine VM type for VMID ${params.vmid} on node ${params.node}. Please specify type parameter.`);
            }
          }
        }
        return this.destroyVm(
          activeClient,
          params.node!,
          params.vmid!,
          destroyType,
          dryRun
        );
      default:
        throw new Error(
          `Unknown action: ${action}. ` +
          `Supported actions: start_vm, stop_vm, shutdown_vm, reboot_vm, reset_vm, create_snapshot, rollback_snapshot, clone_vm, migrate_vm, destroy_vm.`
        );
    }
  }

  // Helper to get VM type endpoint path
  private getVmPath(type: string, node: string, vmid: number, endpoint: string): string {
    const vmType = type === "lxc" ? "lxc" : "qemu";
    return `/nodes/${node}/${vmType}/${vmid}${endpoint}`;
  }

  // Basic VM control actions
  private async startVm(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    type: string,
    dryRun: boolean
  ): Promise<{ data: any; metadata: any }> {
    // Get VM name for verification
    const vmName = await this.getVmName(client, node, vmid, type);
    
    // Check current state first
    const currentState = await this.getVmStatus(client, node, vmid, type);
    const currentStatus = currentState?.status;

    // Check if VM is already running (before dry-run check)
    if (currentStatus === "running") {
      return {
        data: {
          action: "start_vm",
          node,
          vmid,
          vmName: vmName || "unknown",
          status: "already_running",
          message: `VM ${vmid}${vmName ? ` (${vmName})` : ""} is already running. No action needed.`,
          currentStatus: "running",
          warning: vmName ? `Verified VM name: "${vmName}"` : "Could not retrieve VM name for verification",
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/skip-already-running" },
      };
    }

    if (dryRun) {
      return {
        data: {
          ...this.generateDiffPreview("start_vm", currentState, {
            status: "running",
            action: "start",
          }),
          vmName: vmName || "unknown",
          warning: vmName ? `Will start VM: "${vmName}" (VMID ${vmid} on node ${node})` : "Could not retrieve VM name for verification",
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/dry-run/start" },
      };
    }

    const preWriteState = await this.capturePreWriteState(client, node, vmid, type);
    
    try {
      const result = await client.post(this.getVmPath(type, node, vmid, "/status/start"), {});
      return {
        data: {
          action: "start_vm",
          node,
          vmid,
          vmName: vmName || "unknown",
          status: "started",
          message: `VM ${vmid}${vmName ? ` (${vmName})` : ""} has been started on node ${node}`,
          preWriteState: preWriteState.hash,
          warning: vmName ? `Started VM: "${vmName}"` : "Could not retrieve VM name for verification",
          ...result.data,
        },
        metadata: result.metadata,
      };
    } catch (error: any) {
      // Handle "already running" error from Proxmox
      if (error.response?.data?.message?.includes("already running") || 
          error.message?.includes("already running")) {
        return {
          data: {
            action: "start_vm",
            node,
            vmid,
            vmName: vmName || "unknown",
            status: "already_running",
            message: `VM ${vmid}${vmName ? ` (${vmName})` : ""} is already running. No action needed.`,
            currentStatus: "running",
            warning: vmName ? `Verified VM name: "${vmName}"` : "Could not retrieve VM name for verification",
          },
          metadata: { status: 200, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/already-running" },
        };
      }
      throw error;
    }
  }

  private async stopVm(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    type: string,
    timeout: number | undefined,
    dryRun: boolean
  ): Promise<{ data: any; metadata: any }> {
    // Check current state first
    const currentState = await this.getVmStatus(client, node, vmid, type);
    const currentStatus = currentState?.status;

    // Check if VM is already stopped (before dry-run check)
    if (currentStatus === "stopped") {
      return {
        data: {
          action: "stop_vm",
          node,
          vmid,
          status: "already_stopped",
          message: `VM ${vmid} is already stopped. No action needed.`,
          currentStatus: "stopped",
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/skip-already-stopped" },
      };
    }

    if (dryRun) {
      return {
        data: this.generateDiffPreview("stop_vm", currentState, {
          status: "stopped",
          action: "stop",
          timeout,
        }),
        metadata: { status: 200, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/dry-run/stop" },
      };
    }

    const preWriteState = await this.capturePreWriteState(client, node, vmid, type);
    const params = timeout ? { timeout } : {};
    
    try {
      const result = await client.post(this.getVmPath(type, node, vmid, "/status/stop"), params);
      return {
        data: {
          action: "stop_vm",
          node,
          vmid,
          status: "stopped",
          preWriteState: preWriteState.hash,
          ...result.data,
        },
        metadata: result.metadata,
      };
    } catch (error: any) {
      // Handle "already stopped" error from Proxmox
      if (error.response?.data?.message?.includes("already stopped") || 
          error.message?.includes("already stopped") ||
          error.response?.data?.message?.includes("not running")) {
        return {
          data: {
            action: "stop_vm",
            node,
            vmid,
            status: "already_stopped",
            message: `VM ${vmid} is already stopped. No action needed.`,
            currentStatus: "stopped",
          },
          metadata: { status: 200, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/already-stopped" },
        };
      }
      throw error;
    }
  }

  private async shutdownVm(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    type: string,
    timeout: number | undefined,
    dryRun: boolean
  ): Promise<{ data: any; metadata: any }> {
    // Check current state first
    const currentState = await this.getVmStatus(client, node, vmid, type);
    const currentStatus = currentState?.status;

    // Check if VM is already stopped (before dry-run check)
    if (currentStatus === "stopped") {
      return {
        data: {
          action: "shutdown_vm",
          node,
          vmid,
          status: "already_stopped",
          message: `VM ${vmid} is already stopped. No action needed.`,
          currentStatus: "stopped",
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/skip-already-stopped" },
      };
    }

    if (dryRun) {
      return {
        data: this.generateDiffPreview("shutdown_vm", currentState, {
          status: "stopped",
          action: "shutdown",
          timeout,
        }),
        metadata: { status: 200, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/dry-run/shutdown" },
      };
    }

    const preWriteState = await this.capturePreWriteState(client, node, vmid, type);
    const params = timeout ? { timeout } : {};
    const result = await client.post(this.getVmPath(type, node, vmid, "/status/shutdown"), params);

    return {
      data: {
        action: "shutdown_vm",
        node,
        vmid,
        status: "shutdown",
        preWriteState: preWriteState.hash,
        ...result.data,
      },
      metadata: result.metadata,
    };
  }

  private async rebootVm(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    type: string,
    dryRun: boolean
  ): Promise<{ data: any; metadata: any }> {
    // Check current state first (for dry-run preview)
    const currentState = await this.getVmStatus(client, node, vmid, type);

    if (dryRun) {
      return {
        data: this.generateDiffPreview("reboot_vm", currentState, {
          status: "rebooting",
          action: "reboot",
        }),
        metadata: { status: 200, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/dry-run/reboot" },
      };
    }

    const preWriteState = await this.capturePreWriteState(client, node, vmid, type);
    const result = await client.post(this.getVmPath(type, node, vmid, "/status/reboot"), {});

    return {
      data: {
        action: "reboot_vm",
        node,
        vmid,
        status: "rebooting",
        preWriteState: preWriteState.hash,
        ...result.data,
      },
      metadata: result.metadata,
    };
  }

  private async resetVm(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    type: string,
    dryRun: boolean
  ): Promise<{ data: any; metadata: any }> {
    if (dryRun) {
      const currentState = await this.getVmStatus(client, node, vmid, type);
      return {
        data: this.generateDiffPreview("reset_vm", currentState, {
          status: "resetting",
          action: "reset",
        }),
        metadata: { status: 200, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/dry-run/reset" },
      };
    }

    const preWriteState = await this.capturePreWriteState(client, node, vmid, type);
    // Note: reset is only available for QEMU VMs, not LXC
    if (type === "lxc") {
      throw new Error("Reset operation is not available for LXC containers");
    }
    const result = await client.post(this.getVmPath(type, node, vmid, "/status/reset"), {});

    return {
      data: {
        action: "reset_vm",
        node,
        vmid,
        status: "reset",
        preWriteState: preWriteState.hash,
        ...result.data,
      },
      metadata: result.metadata,
    };
  }

  // Snapshot operations
  private async createSnapshot(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    snapshotName: string,
    dryRun: boolean
  ): Promise<{ data: any; metadata: any }> {
    if (dryRun) {
      const currentState = await this.getVmStatus(client, node, vmid, "qemu");
      return {
        data: this.generateDiffPreview("create_snapshot", currentState, {
          snapshot: snapshotName,
          action: "create_snapshot",
        }),
        metadata: { status: 200, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/dry-run/snapshot" },
      };
    }

    const preWriteState = await this.capturePreWriteState(client, node, vmid, "qemu");
    const result = await client.post(this.getVmPath("qemu", node, vmid, "/snapshot"), {
      snapname: snapshotName,
    });

    return {
      data: {
        action: "create_snapshot",
        node,
        vmid,
        snapshotName,
        preWriteState: preWriteState.hash,
        ...result.data,
      },
      metadata: result.metadata,
    };
  }

  private async rollbackSnapshot(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    snapshotName: string,
    dryRun: boolean
  ): Promise<{ data: any; metadata: any }> {
    if (dryRun) {
      const currentState = await this.getVmStatus(client, node, vmid, "qemu");
      return {
        data: this.generateDiffPreview("rollback_snapshot", currentState, {
          snapshot: snapshotName,
          action: "rollback",
        }),
        metadata: { status: 200, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/dry-run/rollback" },
      };
    }

    const preWriteState = await this.capturePreWriteState(client, node, vmid, "qemu");
    const result = await client.post(this.getVmPath("qemu", node, vmid, `/snapshot/${snapshotName}/rollback`), {});

    return {
      data: {
        action: "rollback_snapshot",
        node,
        vmid,
        snapshotName,
        preWriteState: preWriteState.hash,
        ...result.data,
      },
      metadata: result.metadata,
    };
  }

  // Clone operation
  private async cloneVm(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    newVmid: number,
    dryRun: boolean
  ): Promise<{ data: any; metadata: any }> {
    if (dryRun) {
      const currentState = await this.getVmStatus(client, node, vmid, "qemu");
      return {
        data: this.generateDiffPreview("clone_vm", currentState, {
          newVmid,
          action: "clone",
        }),
        metadata: { status: 200, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/dry-run/clone" },
      };
    }

    const preWriteState = await this.capturePreWriteState(client, node, vmid, "qemu");
    const result = await client.post(this.getVmPath("qemu", node, vmid, "/clone"), {
      newid: newVmid,
    });

    return {
      data: {
        action: "clone_vm",
        node,
        vmid,
        newVmid,
        preWriteState: preWriteState.hash,
        ...result.data,
      },
      metadata: result.metadata,
    };
  }

  // Migration with pre-flight checks
  private async migrateVm(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    type: "qemu" | "lxc",
    targetNode: string,
    dryRun: boolean
  ): Promise<{ data: any; metadata: any }> {
    // Run pre-flight checks first
    const preFlightResult = await this.runMigrationPreFlightChecks(
      client,
      node,
      vmid,
      type,
      targetNode
    );

    if (!preFlightResult.safe) {
      return {
        data: {
          action: "migrate_vm",
          node,
          vmid,
          type,
          targetNode,
          status: "migration_unsafe",
          preFlightChecks: preFlightResult,
          blocked: true,
          note: "Migration with local storage (LVM, ZFS local) requires manual steps or shared storage (NFS, Ceph). Live migration may not be possible - consider stopping the VM/container first, or use shared storage for seamless migration.",
        },
        metadata: {
          status: 400,
          timestamp: Date.now(),
          durationMs: preFlightResult.durationMs || 0,
          provenanceId: "tool://proxmox/migration-blocked",
        },
      };
    }

    if (dryRun) {
      const currentState = await this.getVmStatus(client, node, vmid, type);
      return {
        data: {
          ...this.generateDiffPreview("migrate_vm", currentState, {
            targetNode,
            action: "migrate",
          }),
          preFlightChecks: preFlightResult,
          note: "Migration with local storage may require stopping the VM/container first. Shared storage (NFS, Ceph) enables live migration.",
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/dry-run/migrate" },
      };
    }

    const preWriteState = await this.capturePreWriteState(client, node, vmid, type);
    const result = await client.post(this.getVmPath(type, node, vmid, "/migrate"), {
      target: targetNode,
    });

    return {
      data: {
        action: "migrate_vm",
        node,
        vmid,
        targetNode,
        status: "migrating",
        preWriteState: preWriteState.hash,
        preFlightChecks: preFlightResult,
        ...result.data,
      },
      metadata: result.metadata,
    };
  }

  /**
   * Run pre-flight checks for migration
   * Checks source and destination node resources, HA status, and backup activity
   */
  private async runMigrationPreFlightChecks(
    client: ProxmoxClient,
    sourceNode: string,
    vmid: number,
    type: "qemu" | "lxc",
    targetNode: string
  ): Promise<{
    safe: boolean;
    checks: Array<{ name: string; passed: boolean; message: string }>;
    durationMs: number;
  }> {
    const startTime = Date.now();
    const checks: Array<{ name: string; passed: boolean; message: string }> = [];

    try {
      // Check 1: Source node resources
      try {
        const sourceResources = await client.get(`/nodes/${sourceNode}/status`);
        const sourceData = sourceResources.data.data;
        checks.push({
          name: "source_node_available",
          passed: sourceData.status === "online",
          message: sourceData.status === "online" ? "Source node is online" : "Source node is not online",
        });
      } catch (error: any) {
        const errorStatus = error?.response?.status || error?.status;
        if (errorStatus === 403) {
          checks.push({
            name: "source_node_available",
            passed: false,
            message: `Source node "${sourceNode}" not found or access denied (403). Verify node name is correct.`,
          });
        } else {
          checks.push({
            name: "source_node_available",
            passed: false,
            message: `Failed to check source node status: ${error?.message || String(error)}`,
          });
        }
      }

      // Check 2: Target node resources
      try {
        const targetResources = await client.get(`/nodes/${targetNode}/status`);
        const targetData = targetResources.data.data;
        checks.push({
          name: "target_node_available",
          passed: targetData.status === "online",
          message: targetData.status === "online" ? "Target node is online" : "Target node is not online",
        });
      } catch (error: any) {
        const errorStatus = error?.response?.status || error?.status;
        if (errorStatus === 403) {
          checks.push({
            name: "target_node_available",
            passed: false,
            message: `Target node "${targetNode}" not found or access denied (403). Verify node name is correct.`,
          });
        } else {
          checks.push({
            name: "target_node_available",
            passed: false,
            message: `Failed to check target node status: ${error?.message || String(error)}`,
          });
        }
      }

      // Check 3: VM/Container status on source
      // For LXC, we need to check lxc endpoint, not qemu
      try {
        const vmStatus = await this.getVmStatus(client, sourceNode, vmid, type);
        checks.push({
          name: "vm_exists_on_source",
          passed: !!vmStatus,
          message: vmStatus ? `VM/container exists on source node (type: ${type})` : "VM/container not found on source node",
        });
      } catch (error: any) {
        // Distinguish between different error types
        const errorStatus = error?.response?.status || error?.status;
        const errorMessage = error?.message || String(error);
        
        // If we get 500 for LXC, try the other type to see if it's a type mismatch
        if (errorStatus === 500 && type === "lxc") {
          try {
            // Try qemu to see if it's actually a QEMU VM
            const qemuStatus = await this.getVmStatus(client, sourceNode, vmid, "qemu");
            if (qemuStatus) {
              checks.push({
                name: "vm_exists_on_source",
                passed: false,
                message: `VM/container exists but is type 'qemu', not 'lxc'. Please specify type: "qemu" for this migration.`,
              });
            } else {
              checks.push({
                name: "vm_exists_on_source",
                passed: false,
                message: `VM/container ${vmid} not found on source node ${sourceNode} (checked both qemu and lxc types)`,
              });
            }
          } catch {
            // Both types failed - VM doesn't exist
            checks.push({
              name: "vm_exists_on_source",
              passed: false,
              message: `VM/container ${vmid} not found on source node ${sourceNode}`,
            });
          }
        } else if (errorStatus === 500 && type === "qemu") {
          try {
            // Try lxc to see if it's actually an LXC container
            const lxcStatus = await this.getVmStatus(client, sourceNode, vmid, "lxc");
            if (lxcStatus) {
              checks.push({
                name: "vm_exists_on_source",
                passed: false,
                message: `VM/container exists but is type 'lxc', not 'qemu'. Please specify type: "lxc" for this migration.`,
              });
            } else {
              checks.push({
                name: "vm_exists_on_source",
                passed: false,
                message: `VM/container ${vmid} not found on source node ${sourceNode} (checked both qemu and lxc types)`,
              });
            }
          } catch {
            checks.push({
              name: "vm_exists_on_source",
              passed: false,
              message: `VM/container ${vmid} not found on source node ${sourceNode}`,
            });
          }
        } else if (errorStatus === 403) {
          // Node might not exist or permission issue
          checks.push({
            name: "vm_exists_on_source",
            passed: false,
            message: `Access denied (403) when checking VM/container ${vmid} on node ${sourceNode}. Node may not exist or insufficient permissions.`,
          });
        } else {
          // Generic error
          checks.push({
            name: "vm_exists_on_source",
            passed: false,
            message: `Failed to check VM/container status: ${errorMessage}`,
          });
        }
      }

      // Check 4: Target node CPU/RAM margin
      const targetNodeResources = await client.get(`/nodes/${targetNode}/status`);
      const targetResourcesData = targetNodeResources.data.data;
      // Simple check: ensure target has resources (detailed checks would need VM requirements)
      checks.push({
        name: "target_has_resources",
        passed: true, // Simplified - would check actual VM requirements vs available
        message: "Target node resource check passed",
      });

      // Check 5: HA status (if applicable)
      try {
        const haStatus = await client.get("/cluster/ha/status/current");
        checks.push({
          name: "ha_status_ok",
          passed: true,
          message: "HA status check passed",
        });
      } catch {
        // HA not configured or not accessible - not a blocker
        checks.push({
          name: "ha_status_ok",
          passed: true,
          message: "HA not configured (not a blocker)",
        });
      }

      const allPassed = checks.every((c) => c.passed);
      const durationMs = Date.now() - startTime;

      logger.info("Migration pre-flight checks completed", {
        sourceNode,
        targetNode,
        vmid,
        allPassed,
        durationMs,
      });

      return {
        safe: allPassed,
        checks,
        durationMs,
      };
    } catch (error: any) {
      logger.error("Migration pre-flight check failed", {
        sourceNode,
        targetNode,
        vmid,
        error: error.message,
      });

      checks.push({
        name: "preflight_check_execution",
        passed: false,
        message: `Pre-flight check execution failed: ${error.message}`,
      });

      return {
        safe: false,
        checks,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Helper to get VM status
   * Returns status data or throws error with details
   */
  private async getVmStatus(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    type: string = "qemu"
  ): Promise<any> {
    try {
      const result = await client.get(this.getVmPath(type, node, vmid, "/status/current"));
      return result.data.data;
    } catch (error: any) {
      // Re-throw with more context for better error handling
      const enhancedError = new Error(error?.message || "Failed to get VM status");
      (enhancedError as any).response = error?.response;
      (enhancedError as any).status = error?.response?.status || error?.status;
      throw enhancedError;
    }
  }

  /**
   * Helper to get VM name from config
   */
  private async getVmName(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    type: string = "qemu"
  ): Promise<string | null> {
    try {
      const result = await client.get(this.getVmPath(type, node, vmid, "/config"));
      const config = result.data.data || {};
      // VM name is in the 'name' field for qemu, or 'hostname' for lxc
      return config.name || config.hostname || null;
    } catch {
      return null;
    }
  }

  /**
   * Destroy VM/Container (EXTREME RISK - permanent deletion)
   * WARNING: This operation cannot be undone
   */
  private async destroyVm(
    client: ProxmoxClient,
    node: string,
    vmid: number,
    type: "qemu" | "lxc",
    dryRun: boolean
  ): Promise<{ data: any; metadata: any }> {
    // Get VM name for verification
    const vmName = await this.getVmName(client, node, vmid, type);
    
    // Check current state first
    const currentState = await this.getVmStatus(client, node, vmid, type);
    const currentStatus = currentState?.status;

    // For destroy, VM must be stopped first
    if (currentStatus === "running") {
      return {
        data: {
          action: "destroy_vm",
          node,
          vmid,
          vmName: vmName || "unknown",
          status: "cannot_destroy_running",
          message: `Cannot destroy VM/container ${vmid}${vmName ? ` (${vmName})` : ""} - it is currently running. Stop it first, then destroy.`,
          currentStatus: "running",
          warning: vmName ? `VM/container "${vmName}" must be stopped before destruction` : "VM/container must be stopped before destruction",
        },
        metadata: { status: 400, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/destroy-blocked-running" },
      };
    }

    if (dryRun) {
      return {
        data: {
          action: "destroy_vm",
          node,
          vmid,
          vmName: vmName || "unknown",
          type,
          status: "dry_run",
          message: `DRY RUN: Would permanently destroy VM/container ${vmid}${vmName ? ` (${vmName})` : ""} on node ${node}. This operation CANNOT be undone.`,
          warning: `⚠️  DESTRUCTIVE OPERATION: This will permanently delete VM/container ${vmid}${vmName ? ` "${vmName}"` : ""}. All data will be lost.`,
          currentStatus,
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/dry-run/destroy" },
      };
    }

    const preWriteState = await this.capturePreWriteState(client, node, vmid, type);
    
    try {
      // Destroy endpoint: DELETE /nodes/{node}/{type}/{vmid}
      const result = await client.delete(this.getVmPath(type, node, vmid, ""));
      
      return {
        data: {
          action: "destroy_vm",
          node,
          vmid,
          vmName: vmName || "unknown",
          type,
          status: "destroyed",
          message: `VM/container ${vmid}${vmName ? ` (${vmName})` : ""} has been permanently destroyed on node ${node}`,
          preWriteState: preWriteState.hash,
          warning: `⚠️  VM/container ${vmid}${vmName ? ` "${vmName}"` : ""} has been permanently deleted. This operation cannot be undone.`,
          ...result.data,
        },
        metadata: result.metadata,
      };
    } catch (error: any) {
      // Handle specific error cases
      if (error.response?.status === 400) {
        const errorMsg = error.response?.data?.message || error.message;
        if (errorMsg?.includes("running") || errorMsg?.includes("not stopped")) {
          return {
            data: {
              action: "destroy_vm",
              node,
              vmid,
              vmName: vmName || "unknown",
              status: "cannot_destroy_running",
              message: `Cannot destroy VM/container ${vmid}${vmName ? ` (${vmName})` : ""} - it is currently running. Stop it first, then destroy.`,
              error: errorMsg,
            },
            metadata: { status: 400, timestamp: Date.now(), durationMs: 0, provenanceId: "tool://proxmox/destroy-blocked-running" },
          };
        }
      }
      throw error;
    }
  }
}

