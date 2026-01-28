/**
 * Stale Node Cleanup Service
 * 
 * Detects and removes nodes from the digital twin that no longer exist in source systems.
 * Supports multiple entity types: VMs, nodes, interfaces, subnets, firewall rules, storage.
 */

import neo4j from "neo4j-driver";
import { Neo4jGraphStore } from "../../pce/kg/indexation/neo4j-client";
import { ProxmoxClient } from "../../tools/proxmox/client";
import { pceLogger } from "../../pce/utils/logger";

export interface StaleCleanupResult {
  entityType: string;
  deleted: number;
  errors: number;
  details: string[];
}

export interface StaleCleanupOptions {
  maxAgeMinutes?: number; // Consider nodes stale if not seen in this many minutes
  dryRun?: boolean; // If true, only report what would be deleted
}

/**
 * Service to clean stale nodes from the digital twin
 */
export class StaleNodeCleaner {
  private graphStore: Neo4jGraphStore;
  private staleThresholdMs: number;

  constructor(
    graphStore: Neo4jGraphStore = new Neo4jGraphStore(),
    options: StaleCleanupOptions = {}
  ) {
    this.graphStore = graphStore;
    // Default: consider stale if not seen in 2x the ingestion interval (10 minutes)
    this.staleThresholdMs = (options.maxAgeMinutes || 10) * 60 * 1000;
  }

  /**
   * Clean all stale entity types
   */
  async cleanAll(options: StaleCleanupOptions = {}): Promise<StaleCleanupResult[]> {
    await this.graphStore.connect();
    const results: StaleCleanupResult[] = [];

    try {
      // Clean each entity type
      results.push(await this.cleanStaleVms(options));
      results.push(await this.cleanStaleNodes(options));
      results.push(await this.cleanStaleInterfaces(options));
      results.push(await this.cleanStaleSubnets(options));
      results.push(await this.cleanStaleFirewallRules(options));
      results.push(await this.cleanStaleStorage(options));
      results.push(await this.cleanStaleByLastSeen(options));

      const totalDeleted = results.reduce((sum, r) => sum + r.deleted, 0);
      const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);

      pceLogger.info("Stale node cleanup complete", {
        totalDeleted,
        totalErrors,
        results: results.map(r => ({ type: r.entityType, deleted: r.deleted })),
      });

      return results;
    } catch (error: any) {
      pceLogger.error("Stale node cleanup failed", { error: error.message });
      throw error;
    }
  }

  /**
   * Clean stale VMs (nodes that no longer exist in Proxmox)
   */
  async cleanStaleVms(options: StaleCleanupOptions = {}): Promise<StaleCleanupResult> {
    const result: StaleCleanupResult = {
      entityType: "compute_vm",
      deleted: 0,
      errors: 0,
      details: [],
    };

    try {
      // Get Proxmox config
      const proxmoxConfig = this.getProxmoxConfig();
      if (!proxmoxConfig) {
        result.details.push("Proxmox not configured, skipping VM cleanup");
        return result;
      }

      // Get all VMs from twin
      const session = this.graphStore.getSession();
      const twinVmsResult = await session.run(
        `
          MATCH (vm:TwinEntity {type: $type})
          OPTIONAL MATCH (vm)-[:RUNS_ON]->(n:TwinEntity {type: $nodeType})
          RETURN vm.id AS id,
                 vm.displayName AS name,
                 n.displayName AS nodeName,
                 vm.vmKind AS vmKind,
                 vm.collectedAt AS lastSeen
        `,
        {
          type: "compute_vm",
          nodeType: "compute_node",
        }
      );

      const twinVms = twinVmsResult.records.map((record) => ({
        id: record.get("id") as string,
        name: record.get("name") as string,
        nodeName: record.get("nodeName") ?? undefined,
        vmKind: record.get("vmKind") ?? undefined,
        lastSeen: record.get("lastSeen")?.toString() ?? null,
      }));

      if (twinVms.length === 0) {
        result.details.push("No VMs found in twin");
        await session.close();
        return result;
      }

      // Get all VMs from all configured Proxmox clusters
      const allConfigs = this.getAllProxmoxConfigs();
      const proxmoxResources: any[] = [];

      for (const config of allConfigs) {
        try {
          const client = new ProxmoxClient({
            url: config.url,
            tokenId: config.tokenId,
            tokenSecret: config.tokenSecret,
            verifySsl: config.verifySsl,
          });
          const resourcesResult = await client.get("/cluster/resources");
          const clusterResources = resourcesResult.data?.data || [];
          proxmoxResources.push(...clusterResources);
          pceLogger.debug(`Fetched ${clusterResources.length} resources from ${config.clusterName} cluster`);
        } catch (error: any) {
          pceLogger.warn(`Failed to fetch resources from ${config.clusterName} cluster`, {
            error: error.message,
            url: config.url,
          });
          // Continue with other clusters
        }
      }

      // Filter to only VM resources (qemu, lxc)
      const proxmoxVms = proxmoxResources.filter((r: any) => r.type === "qemu" || r.type === "lxc");
      
      pceLogger.debug(`Found ${proxmoxVms.length} VMs across all clusters`, {
        sampleVms: proxmoxVms.slice(0, 5).map((r: any) => ({
          vmid: r.vmid,
          name: r.name,
          node: r.node,
          type: r.type,
        })),
      });

      // Find stale VMs
      const staleVmIds: string[] = [];

      for (const twinVm of twinVms) {
        const idParts = twinVm.id.split(":");
        const vmid = idParts.length > 0 ? parseInt(idParts[idParts.length - 1], 10) : null;

        if (!vmid || isNaN(vmid)) {
          pceLogger.debug(`Skipping VM with invalid ID format: ${twinVm.id}`);
          continue;
        }

        const vmExists = proxmoxVms.some((r: any) => {
          const matchesVmid = r.vmid === vmid;
          const matchesType = !twinVm.vmKind || r.type === twinVm.vmKind;
          // Node matching: be flexible - if nodeName is not set in twin, match any node
          const matchesNode = !twinVm.nodeName || 
            !r.node || // If Proxmox doesn't have node, still match (might be cluster resource)
            r.node?.toLowerCase() === twinVm.nodeName.toLowerCase();
          return matchesVmid && matchesType && matchesNode;
        });

        if (!vmExists) {
          staleVmIds.push(twinVm.id);
          result.details.push(`VM ${twinVm.name || twinVm.id} (vmid: ${vmid}, node: ${twinVm.nodeName || "any"}, type: ${twinVm.vmKind || "any"}) not found in Proxmox`);
        }
      }

      // Delete stale VMs
      if (staleVmIds.length > 0) {
        if (options.dryRun) {
          result.details.push(`Would delete ${staleVmIds.length} stale VMs`);
        } else {
          for (const staleId of staleVmIds) {
            try {
              await session.run(
                `MATCH (vm:TwinEntity {id: $id}) DETACH DELETE vm`,
                { id: staleId }
              );
              result.deleted++;
            } catch (error: any) {
              pceLogger.error("Error deleting stale VM", { id: staleId, error: error.message });
              result.errors++;
            }
          }
        }
      } else {
        result.details.push("No stale VMs found");
      }

      await session.close();
      return result;
    } catch (error: any) {
      pceLogger.error("Error cleaning stale VMs", { error: error.message });
      result.errors++;
      result.details.push(`Error: ${error.message}`);
      return result;
    }
  }

  /**
   * Clean stale compute nodes
   */
  async cleanStaleNodes(options: StaleCleanupOptions = {}): Promise<StaleCleanupResult> {
    const result: StaleCleanupResult = {
      entityType: "compute_node",
      deleted: 0,
      errors: 0,
      details: [],
    };

    try {
      const proxmoxConfig = this.getProxmoxConfig();
      if (!proxmoxConfig) {
        result.details.push("Proxmox not configured, skipping node cleanup");
        return result;
      }

      const session = this.graphStore.getSession();
      const twinNodesResult = await session.run(
        `MATCH (n:TwinEntity {type: $type}) RETURN n.id AS id, n.displayName AS name`,
        { type: "compute_node" }
      );

      const twinNodes = twinNodesResult.records.map((r) => ({
        id: r.get("id") as string,
        name: r.get("name") as string,
      }));

      if (twinNodes.length === 0) {
        result.details.push("No nodes found in twin");
        await session.close();
        return result;
      }

      // Get nodes from all configured Proxmox clusters
      // Use /cluster/resources instead of /nodes to get all nodes across clusters
      const allConfigs = this.getAllProxmoxConfigs();
      const proxmoxNodeNames = new Set<string>();

      for (const config of allConfigs) {
        try {
          const client = new ProxmoxClient({
            url: config.url,
            tokenId: config.tokenId,
            tokenSecret: config.tokenSecret,
            verifySsl: config.verifySsl,
          });
          
          // Try /cluster/resources first (works for clusters)
          let clusterNodes: any[] = [];
          try {
            const resourcesResult = await client.get("/cluster/resources");
            const allResources = resourcesResult.data?.data || [];
            clusterNodes = allResources.filter((r: any) => r.type === "node");
            pceLogger.debug(`Fetched ${clusterNodes.length} nodes from ${config.clusterName} cluster via /cluster/resources`);
          } catch (resourcesError: any) {
            // Fallback to /nodes if /cluster/resources fails (standalone nodes)
            pceLogger.debug(`/cluster/resources failed for ${config.clusterName}, trying /nodes`, {
              error: resourcesError.message,
            });
            const nodesResult = await client.get("/nodes");
            clusterNodes = nodesResult.data?.data || [];
            pceLogger.debug(`Fetched ${clusterNodes.length} nodes from ${config.clusterName} cluster via /nodes`);
          }
          
          clusterNodes.forEach((n: any) => {
            const nodeName = n.node || n.name;
            if (nodeName) {
              proxmoxNodeNames.add(nodeName.toLowerCase());
            }
          });
        } catch (error: any) {
          pceLogger.warn(`Failed to fetch nodes from ${config.clusterName} cluster`, {
            error: error.message,
            url: config.url,
          });
          // Continue with other clusters
        }
      }
      
      pceLogger.debug(`Total unique nodes found across all clusters: ${proxmoxNodeNames.size}`, {
        nodes: Array.from(proxmoxNodeNames),
      });

      const staleNodeIds: string[] = [];

      for (const twinNode of twinNodes) {
        const nodeName = twinNode.name?.toLowerCase() || twinNode.id.split(":").pop()?.toLowerCase();
        if (!nodeName) {
          pceLogger.debug(`Skipping node with no name: ${twinNode.id}`);
          continue;
        }
        
        if (!proxmoxNodeNames.has(nodeName)) {
          staleNodeIds.push(twinNode.id);
          result.details.push(`Node ${twinNode.name || twinNode.id} not found in Proxmox (searched: ${Array.from(proxmoxNodeNames).join(", ")})`);
        } else {
          pceLogger.debug(`Node ${twinNode.name} found in Proxmox`);
        }
      }

      if (staleNodeIds.length > 0) {
        if (options.dryRun) {
          result.details.push(`Would delete ${staleNodeIds.length} stale nodes`);
        } else {
          for (const staleId of staleNodeIds) {
            try {
              await session.run(
                `MATCH (n:TwinEntity {id: $id}) DETACH DELETE n`,
                { id: staleId }
              );
              result.deleted++;
            } catch (error: any) {
              pceLogger.error("Error deleting stale node", { id: staleId, error: error.message });
              result.errors++;
            }
          }
        }
      } else {
        result.details.push("No stale nodes found");
      }

      await session.close();
      return result;
    } catch (error: any) {
      pceLogger.error("Error cleaning stale nodes", { error: error.message });
      result.errors++;
      result.details.push(`Error: ${error.message}`);
      return result;
    }
  }

  /**
   * Clean stale network interfaces (interfaces that no longer exist on nodes/VMs)
   */
  async cleanStaleInterfaces(options: StaleCleanupOptions = {}): Promise<StaleCleanupResult> {
    const result: StaleCleanupResult = {
      entityType: "network_interface",
      deleted: 0,
      errors: 0,
      details: [],
    };

    // For interfaces, we use lastSeen-based cleanup since we can't easily verify
    // all interfaces from source systems in one call
    // This will be handled by cleanStaleByLastSeen
    result.details.push("Interface cleanup handled by lastSeen-based cleanup");
    return result;
  }

  /**
   * Clean stale subnets (subnets that no longer have any interfaces)
   */
  async cleanStaleSubnets(options: StaleCleanupOptions = {}): Promise<StaleCleanupResult> {
    const result: StaleCleanupResult = {
      entityType: "network_subnet",
      deleted: 0,
      errors: 0,
      details: [],
    };

    try {
      const session = this.graphStore.getSession();
      
      // Find subnets with no connected interfaces
      const staleSubnetsResult = await session.run(
        `
          MATCH (subnet:TwinEntity {type: $type})
          OPTIONAL MATCH (iface:TwinEntity {type: $ifaceType})-[:CONNECTS_TO]->(subnet)
          WITH subnet, count(iface) AS interfaceCount
          WHERE interfaceCount = 0
          RETURN subnet.id AS id, subnet.displayName AS name
        `,
        {
          type: "network_subnet",
          ifaceType: "network_interface",
        }
      );

      const staleSubnets = staleSubnetsResult.records.map((r) => ({
        id: r.get("id") as string,
        name: r.get("name") as string,
      }));

      if (staleSubnets.length > 0) {
        if (options.dryRun) {
          result.details.push(`Would delete ${staleSubnets.length} subnets with no interfaces`);
        } else {
          for (const subnet of staleSubnets) {
            try {
              await session.run(
                `MATCH (s:TwinEntity {id: $id}) DETACH DELETE s`,
                { id: subnet.id }
              );
              result.deleted++;
            } catch (error: any) {
              pceLogger.error("Error deleting stale subnet", { id: subnet.id, error: error.message });
              result.errors++;
            }
          }
        }
      } else {
        result.details.push("No stale subnets found");
      }

      await session.close();
      return result;
    } catch (error: any) {
      pceLogger.error("Error cleaning stale subnets", { error: error.message });
      result.errors++;
      result.details.push(`Error: ${error.message}`);
      return result;
    }
  }

  /**
   * Clean stale firewall rules (rules that no longer exist in OPNsense)
   */
  async cleanStaleFirewallRules(options: StaleCleanupOptions = {}): Promise<StaleCleanupResult> {
    const result: StaleCleanupResult = {
      entityType: "firewall_rule",
      deleted: 0,
      errors: 0,
      details: [],
    };

    // Firewall rules are harder to verify directly, so we use lastSeen-based cleanup
    result.details.push("Firewall rule cleanup handled by lastSeen-based cleanup");
    return result;
  }

  /**
   * Clean stale storage entities (storage that no longer exists on nodes)
   */
  async cleanStaleStorage(options: StaleCleanupOptions = {}): Promise<StaleCleanupResult> {
    const result: StaleCleanupResult = {
      entityType: "storage",
      deleted: 0,
      errors: 0,
      details: [],
    };

    try {
      const proxmoxConfig = this.getProxmoxConfig();
      if (!proxmoxConfig) {
        result.details.push("Proxmox not configured, skipping storage cleanup");
        return result;
      }

      const session = this.graphStore.getSession();
      const twinStorageResult = await session.run(
        `
          MATCH (s:TwinEntity {type: $type})
          OPTIONAL MATCH (s)-[:ATTACHED_TO]->(n:TwinEntity {type: $nodeType})
          RETURN s.id AS id,
                 s.displayName AS name,
                 n.displayName AS nodeName
        `,
        {
          type: "storage",
          nodeType: "compute_node",
        }
      );

      const twinStorage = twinStorageResult.records.map((r) => ({
        id: r.get("id") as string,
        name: r.get("name") as string,
        nodeName: r.get("nodeName") ?? undefined,
      }));

      if (twinStorage.length === 0) {
        result.details.push("No storage entities found in twin");
        await session.close();
        return result;
      }

      // Get all storage from all configured Proxmox clusters
      const allConfigs = this.getAllProxmoxConfigs();
      const proxmoxStorageMap = new Map<string, Set<string>>(); // node -> storage names

      for (const config of allConfigs) {
        try {
          const client = new ProxmoxClient({
            url: config.url,
            tokenId: config.tokenId,
            tokenSecret: config.tokenSecret,
            verifySsl: config.verifySsl,
          });

          // Get nodes first
          let clusterNodes: any[] = [];
          try {
            const resourcesResult = await client.get("/cluster/resources");
            const allResources = resourcesResult.data?.data || [];
            clusterNodes = allResources.filter((r: any) => r.type === "node");
          } catch {
            const nodesResult = await client.get("/nodes");
            clusterNodes = nodesResult.data?.data || [];
          }

          // Fetch storage for each node
          for (const node of clusterNodes) {
            const nodeName = (node.node || node.name)?.toLowerCase();
            if (!nodeName) continue;

            try {
              const storageResult = await client.get(`/nodes/${nodeName}/storage`);
              const storageList = storageResult.data?.data || [];
              const storageNames = new Set(
                storageList.map((s: any) => s.storage?.toLowerCase()).filter(Boolean)
              );
              proxmoxStorageMap.set(nodeName, storageNames);
            } catch (error: any) {
              pceLogger.debug(`Failed to fetch storage for node ${nodeName}`, {
                error: error.message,
              });
            }
          }
        } catch (error: any) {
          pceLogger.warn(`Failed to fetch storage from ${config.clusterName} cluster`, {
            error: error.message,
          });
        }
      }

      // Find stale storage
      const staleStorageIds: string[] = [];

      for (const twinStorageEntity of twinStorage) {
        // Extract node and storage name from ID: "storage:node:storageName"
        const idParts = twinStorageEntity.id.split(":");
        if (idParts.length < 3) continue;

        const nodeName = idParts[1]?.toLowerCase();
        const storageName = idParts[2]?.toLowerCase();

        if (!nodeName || !storageName) continue;

        const nodeStorageSet = proxmoxStorageMap.get(nodeName);
        if (!nodeStorageSet || !nodeStorageSet.has(storageName)) {
          staleStorageIds.push(twinStorageEntity.id);
          result.details.push(
            `Storage ${twinStorageEntity.name || twinStorageEntity.id} not found on node ${nodeName}`
          );
        }
      }

      if (staleStorageIds.length > 0) {
        if (options.dryRun) {
          result.details.push(`Would delete ${staleStorageIds.length} stale storage entities`);
        } else {
          for (const staleId of staleStorageIds) {
            try {
              await session.run(`MATCH (s:TwinEntity {id: $id}) DETACH DELETE s`, { id: staleId });
              result.deleted++;
            } catch (error: any) {
              pceLogger.error("Error deleting stale storage", { id: staleId, error: error.message });
              result.errors++;
            }
          }
        }
      } else {
        result.details.push("No stale storage entities found");
      }

      await session.close();
      return result;
    } catch (error: any) {
      pceLogger.error("Error cleaning stale storage", { error: error.message });
      result.errors++;
      result.details.push(`Error: ${error.message}`);
      return result;
    }
  }

  /**
   * Clean nodes that haven't been seen recently (based on collectedAt/lastSeen)
   */
  async cleanStaleByLastSeen(options: StaleCleanupOptions = {}): Promise<StaleCleanupResult> {
    const result: StaleCleanupResult = {
      entityType: "all_by_lastseen",
      deleted: 0,
      errors: 0,
      details: [],
    };

    try {
      const session = this.graphStore.getSession();
      const threshold = new Date(Date.now() - this.staleThresholdMs);

      // Find entities that haven't been updated recently
      const staleEntitiesResult = await session.run(
        `
          MATCH (e:TwinEntity)
          WHERE e.collectedAt < $threshold
            AND e.type IN $types
          RETURN e.id AS id, e.type AS type, e.displayName AS name, e.collectedAt AS lastSeen
          ORDER BY e.collectedAt ASC
        `,
        {
          threshold: neo4j.types.DateTime.fromStandardDate(threshold),
          types: [
            "network_interface",
            "firewall_rule",
            // Don't auto-delete nodes/VMs by lastSeen - use source verification instead
          ],
        }
      );

      const staleEntities = staleEntitiesResult.records.map((r) => ({
        id: r.get("id") as string,
        type: r.get("type") as string,
        name: r.get("name") as string,
        lastSeen: r.get("lastSeen")?.toString() ?? null,
      }));

      if (staleEntities.length > 0) {
        if (options.dryRun) {
          result.details.push(
            `Would delete ${staleEntities.length} entities not seen since ${threshold.toISOString()}`
          );
        } else {
          for (const entity of staleEntities) {
            try {
              await session.run(
                `MATCH (e:TwinEntity {id: $id}) DETACH DELETE e`,
                { id: entity.id }
              );
              result.deleted++;
              result.details.push(`Deleted ${entity.type}:${entity.name || entity.id}`);
            } catch (error: any) {
              pceLogger.error("Error deleting stale entity", {
                id: entity.id,
                error: error.message,
              });
              result.errors++;
            }
          }
        }
      } else {
        result.details.push("No stale entities found by lastSeen");
      }

      await session.close();
      return result;
    } catch (error: any) {
      pceLogger.error("Error cleaning stale entities by lastSeen", { error: error.message });
      result.errors++;
      result.details.push(`Error: ${error.message}`);
      return result;
    }
  }

  /**
   * Get all configured Proxmox clusters
   * Uses same token selection logic as ProxmoxReadOnlyBase.getApiConfig()
   */
  private getAllProxmoxConfigs(): Array<{ url: string; tokenId: string; tokenSecret: string; verifySsl: boolean; clusterName: string }> {
    const configs: Array<{ url: string; tokenId: string; tokenSecret: string; verifySsl: boolean; clusterName: string }> = [];

    // Default cluster (proxBig) - use same logic as ProxmoxReadOnlyBase
    const defaultUrl = process.env.PROXMOX_URL;
    const defaultTokenId = process.env.PROXMOX_TOKEN_ID;
    let defaultTokenSecret = process.env.PROXMOX_TOKEN_SECRET;
    
    // Try to find node-specific token secret based on URL hostname (like readonly tool does)
    if (defaultUrl && defaultTokenSecret) {
      try {
        const urlObj = new URL(defaultUrl);
        const hostname = urlObj.hostname.toLowerCase();
        const nodeName = hostname.split('.')[0].toUpperCase();
        const nodeSpecificSecret = process.env[`${nodeName}_TOKEN_SECRET`];
        if (nodeSpecificSecret) {
          defaultTokenSecret = nodeSpecificSecret;
          pceLogger.debug(`Using node-specific secret for default cluster: ${nodeName}_TOKEN_SECRET`);
        }
      } catch {
        // If URL parsing fails, use default
      }
    }
    
    if (defaultUrl && defaultTokenId && defaultTokenSecret) {
      configs.push({
        url: defaultUrl,
        tokenId: defaultTokenId,
        tokenSecret: defaultTokenSecret,
        verifySsl: process.env.PROXMOX_VERIFY_SSL !== "false",
        clusterName: "default",
      });
    }

    // Yin cluster - use same token selection as ProxmoxReadOnlyTool.getAlternativeEndpoints()
    const yinUrl = process.env.PROXMOX_YIN_URL;
    const yinTokenId = process.env.PROXMOX_TOKEN_ID || process.env.PROXMOX_YIN_TOKEN_ID;
    // Try YIN_TOKEN_SECRET first (node-specific), then PROXMOX_TOKEN_SECRET (cluster-wide)
    const yinTokenSecret = process.env.YIN_TOKEN_SECRET 
      || process.env.PROXMOX_TOKEN_SECRET;
    
    if (yinUrl && yinTokenId && yinTokenSecret) {
      configs.push({
        url: yinUrl,
        tokenId: yinTokenId,
        tokenSecret: yinTokenSecret,
        verifySsl: process.env.PROXMOX_YIN_VERIFY_SSL !== "false",
        clusterName: "yin",
      });
    } else {
      pceLogger.debug("Yin cluster config incomplete", {
        hasUrl: !!yinUrl,
        hasTokenId: !!yinTokenId,
        hasTokenSecret: !!yinTokenSecret,
      });
    }

    // Yang cluster - use same token selection as ProxmoxReadOnlyTool.getAlternativeEndpoints()
    const yangUrl = process.env.PROXMOX_YANG_URL;
    const yangTokenId = process.env.PROXMOX_TOKEN_ID || process.env.PROXMOX_YIN_TOKEN_ID;
    // Try YANG_TOKEN_SECRET first (node-specific), then PROXMOX_TOKEN_SECRET (cluster-wide)
    const yangTokenSecret = process.env.YANG_TOKEN_SECRET 
      || process.env.PROXMOX_TOKEN_SECRET;
    
    if (yangUrl && yangTokenId && yangTokenSecret) {
      configs.push({
        url: yangUrl,
        tokenId: yangTokenId,
        tokenSecret: yangTokenSecret,
        verifySsl: process.env.PROXMOX_YIN_VERIFY_SSL !== "false",
        clusterName: "yang",
      });
    } else {
      pceLogger.debug("Yang cluster config incomplete", {
        hasUrl: !!yangUrl,
        hasTokenId: !!yangTokenId,
        hasTokenSecret: !!yangTokenSecret,
      });
    }

    return configs;
  }

  /**
   * Get Proxmox configuration (legacy - returns first config for backward compatibility)
   */
  private getProxmoxConfig(): { url: string; tokenId: string; tokenSecret: string; verifySsl: boolean } | null {
    const configs = this.getAllProxmoxConfigs();
    if (configs.length === 0) {
      return null;
    }
    const first = configs[0]!;
    return {
      url: first.url,
      tokenId: first.tokenId,
      tokenSecret: first.tokenSecret,
      verifySsl: first.verifySsl,
    };
  }
}
