import type { QueryResult, Record as Neo4jRecord } from "neo4j-driver";
import { Neo4jGraphStore } from "../../pce/kg/indexation/neo4j-client";
import { ProxmoxClient } from "../../tools/proxmox/client";
import { getProxmoxEndpointConfigs } from "../../tools/proxmox/config";
import { pceLogger as logger } from "../../pce/utils/logger";

type VmKind = "qemu" | "lxc" | null;

interface ClusterNodeSummary {
  id: string;
  name: string;
  vmCount: number;
  status?: string;
  temperature?: {
    max?: number;
    average?: number;
    sensors?: number;
  };
}

interface ClusterVmSummary {
  id: string;
  name: string;
  nodeName?: string;
  state?: string;
  agentAvailable?: boolean;
  vmKind?: "qemu" | "lxc";
}

export class TwinQueryService {
  private graphStore: Neo4jGraphStore;
  private ownsGraphStore: boolean;

  constructor(graphStore?: Neo4jGraphStore) {
    if (graphStore) {
      this.graphStore = graphStore;
      this.ownsGraphStore = false;
    } else {
      this.graphStore = new Neo4jGraphStore();
      this.ownsGraphStore = true;
    }
  }

  async close(): Promise<void> {
    if (this.ownsGraphStore && this.graphStore) {
      const driver = this.graphStore.getDriver();
      if (driver) {
        await driver.close();
      }
    }
  }

  private mapInterface(record: Neo4jRecord): any {
    const node = record.get("nodeName") ?? undefined;
    const ipsVal = record.get("ips");
    const ips =
      Array.isArray(ipsVal) || typeof ipsVal === "string"
        ? (ipsVal as any)
        : ipsVal?.toArray?.() ?? [];
    return {
      id: record.get("id") as string,
      name: record.get("name") as string,
      nodeName: node,
      vmId: record.get("vmId") ?? undefined,
      status: record.get("status") ?? undefined,
      vlan: record.get("vlan") ?? undefined,
      primaryIp: record.get("primaryIp") ?? undefined,
      ips,
    };
  }

  async listInterfaces(): Promise<any[]> {
    const result = await this.runQuery(
      `
        MATCH (i:TwinEntity {type: $ifaceType})
        RETURN i.id AS id,
               coalesce(i.displayName, i.id) AS name,
               i.nodeName AS nodeName,
               i.vmId AS vmId,
               i.status AS status,
               i.vlan AS vlan,
               i.primaryIp AS primaryIp,
               i.dataJson AS dataJson,
               i.ips AS ips
        ORDER BY nodeName, name
      `,
      { ifaceType: "network_interface" }
    );

    return result.records.map(this.mapInterface);
  }

  async interfacesByNode(nodeName: string): Promise<any[]> {
    const result = await this.runQuery(
      `
        MATCH (i:TwinEntity {type: $ifaceType})
        WHERE toLower(i.nodeName) = toLower($nodeName)
        RETURN i.id AS id,
               coalesce(i.displayName, i.id) AS name,
               i.nodeName AS nodeName,
               i.vmId AS vmId,
               i.status AS status,
               i.vlan AS vlan,
               i.primaryIp AS primaryIp,
               i.ips AS ips
        ORDER BY name
      `,
      { ifaceType: "network_interface", nodeName }
    );

    return result.records.map(this.mapInterface);
  }

  async subnetsByInterfaceName(interfaceName: string): Promise<string[]> {
    const suffix = `:${interfaceName.toLowerCase()}`;
    const result = await this.runQuery(
      `
        MATCH (i:TwinEntity {type: $ifaceType})-[:CONNECTS_TO]->(s:TwinEntity {type: $subnetType})
        WHERE toLower(i.id) ENDS WITH $suffix
           OR toLower(i.displayName) ENDS WITH $suffix
        RETURN DISTINCT s.displayName AS subnet
        ORDER BY subnet
      `,
      {
        ifaceType: "network_interface",
        subnetType: "network_subnet",
        suffix,
      }
    );

    return result.records
      .map((record) => record.get("subnet") as string)
      .filter((subnet) => Boolean(subnet));
  }

  async vmsBySubnet(subnetCidr: string): Promise<
    Array<{ vmId: string; vmName: string; subnet: string; nodeName?: string }>
  > {
    const result = await this.runQuery(
      `
        MATCH (i:TwinEntity {type: $ifaceType})-[:CONNECTS_TO]->(s:TwinEntity {type: $subnetType})
        MATCH (vm:TwinEntity {type: $vmType})
        WHERE vm.id = i.vmId AND (s.displayName = $subnetCidr OR s.id = $subnetId)
        RETURN vm.id AS vmId,
               coalesce(vm.displayName, vm.id) AS vmName,
               s.displayName AS subnet,
               i.nodeName AS nodeName
        ORDER BY vmName
      `,
      {
        ifaceType: "network_interface",
        subnetType: "network_subnet",
        vmType: "compute_vm",
        subnetCidr,
        subnetId: `network-subnet:${subnetCidr.toLowerCase()}`,
      }
    );

    return result.records.map((record) => ({
      vmId: record.get("vmId") as string,
      vmName: record.get("vmName") as string,
      subnet: record.get("subnet") as string,
      nodeName: record.get("nodeName") ?? undefined,
    }));
  }

  async reachability(fromId: string): Promise<
    Array<{ id: string; name: string; type: string; viaSubnet: string }>
  > {
    const result = await this.runQuery(
      `
        MATCH (src:TwinEntity {id: $fromId})-[:CONNECTS_TO]->(s:TwinEntity {type: $subnetType})
        MATCH (dst:TwinEntity)-[:CONNECTS_TO]->(s)
        WHERE dst.id <> src.id
        RETURN dst.id AS id,
               coalesce(dst.displayName, dst.id) AS name,
               dst.type AS type,
               s.displayName AS subnet
        ORDER BY name
      `,
      { fromId, subnetType: "network_subnet" }
    );

    return result.records.map((record) => ({
      id: record.get("id") as string,
      name: record.get("name") as string,
      type: record.get("type") as string,
      viaSubnet: record.get("subnet") as string,
    }));
  }

  async vmReachabilitySummary(vmId: string): Promise<{
    vmId: string;
    vmName: string;
    nodeName?: string;
    interfaces: Array<{
      interfaceId: string;
      interfaceName: string;
      subnet?: string;
      reachableEntities: number;
    }>;
    exposedSubnets: string[];
    allowedBy: string[];
    blockedBy: string[];
  }> {
    const vmResult = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType, id: $vmId})
        OPTIONAL MATCH (vm)-[:RUNS_ON]->(n:TwinEntity {type: $nodeType})
        RETURN vm.id AS vmId,
               coalesce(vm.displayName, vm.id) AS vmName,
               n.displayName AS nodeName
      `,
      {
        vmType: "compute_vm",
        nodeType: "compute_node",
        vmId,
      }
    );

    if (!vmResult.records.length) {
      throw new Error(`VM not found: ${vmId}`);
    }

    const vmInfo = vmResult.records[0];
    if (!vmInfo) {
      throw new Error(`VM not found: ${vmId}`);
    }
    const ifacesResult = await this.runQuery(
      `
        MATCH (iface:TwinEntity {type: $ifaceType, vmId: $vmId})
        OPTIONAL MATCH (iface)-[:CONNECTS_TO]->(subnet:TwinEntity {type: $subnetType})
        OPTIONAL MATCH (other:TwinEntity)-[:CONNECTS_TO]->(subnet)
        WHERE other.id <> iface.id
        RETURN iface.id AS interfaceId,
               coalesce(iface.displayName, iface.id) AS interfaceName,
               subnet.displayName AS subnet,
               count(DISTINCT other) AS reachableCount
        ORDER BY interfaceName
      `,
      {
        ifaceType: "network_interface",
        subnetType: "network_subnet",
        vmId,
      }
    );

    const interfaces = ifacesResult.records.map((record) => ({
      interfaceId: record.get("interfaceId") as string,
      interfaceName: record.get("interfaceName") as string,
      subnet: record.get("subnet") ?? undefined,
      reachableEntities: this.safeToNumber(record.get("reachableCount")),
    }));

    const exposureResult = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType, id: $vmId})
        OPTIONAL MATCH (iface:TwinEntity {type: $ifaceType, vmId: vm.id})-[:CONNECTS_TO]->(subnet:TwinEntity {type: $subnetType})
        OPTIONAL MATCH (allowRule:TwinEntity {type: $ruleType})-[:ALLOWS]->(subnet)
        OPTIONAL MATCH (blockRule:TwinEntity {type: $ruleType})-[:BLOCKS]->(subnet)
        RETURN collect(DISTINCT subnet.displayName) AS exposedSubnets,
               collect(DISTINCT allowRule.id) AS allowedBy,
               collect(DISTINCT blockRule.id) AS blockedBy
      `,
      {
        vmType: "compute_vm",
        ifaceType: "network_interface",
        subnetType: "network_subnet",
        ruleType: "firewall_rule",
        vmId,
      }
    );

    const exposureRec = exposureResult.records[0];
    const exposedSubnets = (exposureRec?.get("exposedSubnets")?.toArray?.() || exposureRec?.get("exposedSubnets") || []).filter((x: any) => x);
    const allowedBy = (exposureRec?.get("allowedBy")?.toArray?.() || exposureRec?.get("allowedBy") || []).filter((x: any) => x);
    const blockedBy = (exposureRec?.get("blockedBy")?.toArray?.() || exposureRec?.get("blockedBy") || []).filter((x: any) => x);

    return {
      vmId: vmInfo.get("vmId") as string,
      vmName: vmInfo.get("vmName") as string,
      nodeName: vmInfo.get("nodeName") ?? undefined,
      interfaces,
      exposedSubnets,
      allowedBy,
      blockedBy,
    };
  }

  private async ensureConnected(): Promise<void> {
    try {
      this.graphStore.getDriver();
    } catch {
      await this.graphStore.connect();
    }
  }

  private async runQuery(
    query: string,
    params: Record<string, unknown> = {}
  ): Promise<QueryResult> {
    await this.ensureConnected();
    const session = this.graphStore.getDriver().session();
    try {
      return await session.run(query, params);
    } finally {
      await session.close();
    }
  }

  async listAllVms(vmKind: VmKind = null): Promise<ClusterVmSummary[]> {
    const vmsResult = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType})
        WHERE $vmKind IS NULL OR toLower(coalesce(vm.vmKind, 'qemu')) = toLower($vmKind)
        OPTIONAL MATCH (vm)-[:RUNS_ON]->(n:TwinEntity {type: $nodeType})
        RETURN vm.id AS id,
               coalesce(vm.displayName, vm.id) AS name,
               vm.state AS state,
               vm.vmKind AS vmKind,
               n.displayName AS nodeName
        ORDER BY name
      `,
      {
        vmType: "compute_vm",
        nodeType: "compute_node",
        vmKind,
      }
    );

    return vmsResult.records.map((record) => ({
      id: record.get("id") as string,
      name: record.get("name") as string,
      state: record.get("state") ?? undefined,
      vmKind: record.get("vmKind") ?? undefined,
      nodeName: record.get("nodeName") ?? undefined,
    }));
  }

  async describeCluster(vmKind: VmKind = null): Promise<{
    nodes: ClusterNodeSummary[];
    vms: ClusterVmSummary[];
  }> {
    const nodesResult = await this.runQuery(
      `
        MATCH (n:TwinEntity {type: $nodeType})
        OPTIONAL MATCH (vm:TwinEntity {type: $vmType})-[:RUNS_ON]->(n)
        RETURN n.id AS id,
               coalesce(n.displayName, n.id) AS name,
               n.status AS status,
               n.dataJson AS dataJson,
               count(vm) AS vmCount
        ORDER BY name
      `,
      { nodeType: "compute_node", vmType: "compute_vm" }
    );

    const nodes = nodesResult.records.map((record) => {
      const dataJson = record.get("dataJson");
      let temperature: ClusterNodeSummary["temperature"] | undefined;
      if (dataJson) {
        try {
          const data = typeof dataJson === "string" ? JSON.parse(dataJson) : dataJson;
          if (data.temperature) {
            temperature = {
              max: data.temperature.max,
              average: data.temperature.average,
              sensors: data.temperature.sensors,
            };
          }
        } catch {
          // Ignore JSON parse errors
        }
      }
      return {
        id: record.get("id") as string,
        name: record.get("name") as string,
        vmCount: this.safeToNumber(record.get("vmCount")),
        status: record.get("status") ?? undefined,
        temperature,
      };
    });

    const vmsResult = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType})
        WHERE $vmKind IS NULL OR toLower(coalesce(vm.vmKind, 'qemu')) = toLower($vmKind)
        OPTIONAL MATCH (vm)-[:RUNS_ON]->(n:TwinEntity {type: $nodeType})
        RETURN vm.id AS id,
               coalesce(vm.displayName, vm.id) AS name,
               vm.state AS state,
               vm.agentAvailable AS agentAvailable,
               n.displayName AS nodeName,
               vm.vmKind AS vmKind
        ORDER BY name
      `,
      { nodeType: "compute_node", vmType: "compute_vm", vmKind }
    );

    const vms = vmsResult.records.map((record) => ({
      id: record.get("id") as string,
      name: record.get("name") as string,
      nodeName: record.get("nodeName") ?? undefined,
      state: record.get("state") ?? undefined,
      agentAvailable: record.get("agentAvailable") ?? undefined,
      vmKind: record.get("vmKind") ?? undefined,
    }));

    return { nodes, vms };
  }

  /**
   * Get temperature for a specific node or all nodes
   */
  async getNodeTemperature(nodeName?: string): Promise<Array<{
    id: string;
    name: string;
    temperature?: {
      max?: number;
      average?: number;
      sensors?: number;
      readings?: Array<{
        sensor: string;
        label?: string;
        value: number;
        unit: string;
        max?: number;
        crit?: number;
      }>;
    };
  }>> {
    const query = nodeName
      ? `
        MATCH (n:TwinEntity {type: $nodeType})
        WHERE toLower(n.displayName) = toLower($nodeName)
        RETURN n.id AS id,
               coalesce(n.displayName, n.id) AS name,
               n.dataJson AS dataJson
        ORDER BY name
      `
      : `
        MATCH (n:TwinEntity {type: $nodeType})
        RETURN n.id AS id,
               coalesce(n.displayName, n.id) AS name,
               n.dataJson AS dataJson
        ORDER BY name
      `;

    const result = await this.runQuery(query, {
      nodeType: "compute_node",
      nodeName: nodeName?.toLowerCase(),
    });

    return result.records.map((record) => {
      const dataJson = record.get("dataJson");
      let temperature: {
        max?: number;
        average?: number;
        sensors?: number;
        readings?: Array<{
          sensor: string;
          label?: string;
          value: number;
          unit: string;
          max?: number;
          crit?: number;
        }>;
      } | undefined;

      if (dataJson) {
        try {
          const data = typeof dataJson === "string" ? JSON.parse(dataJson) : dataJson;
          if (data.temperature) {
            temperature = {
              max: data.temperature.max,
              average: data.temperature.average,
              sensors: data.temperature.sensors,
              readings: data.temperature.readings,
            };
          }
        } catch {
          // Ignore JSON parse errors
        }
      }

      return {
        id: record.get("id") as string,
        name: record.get("name") as string,
        temperature, // Keep undefined when absent to match return type
      };
    });
  }

  async vmsByNode(
    nodeName: string,
    options: { vmKind?: VmKind } = {}
  ): Promise<ClusterVmSummary[]> {
    const vmKind = options.vmKind === undefined ? "qemu" : options.vmKind;
    const result = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType})-[:RUNS_ON]->(n:TwinEntity {type: $nodeType})
        WHERE toLower(n.displayName) = toLower($nodeName)
          AND ($vmKind IS NULL OR toLower(coalesce(vm.vmKind, 'qemu')) = toLower($vmKind))
        RETURN vm.id AS id,
               coalesce(vm.displayName, vm.id) AS name,
               vm.state AS state,
               vm.agentAvailable AS agentAvailable,
               n.displayName AS nodeName,
               vm.vmKind AS vmKind
        ORDER BY name
      `,
      {
        nodeName,
        nodeType: "compute_node",
        vmType: "compute_vm",
        vmKind,
      }
    );

    return result.records.map((record) => ({
      id: record.get("id") as string,
      name: record.get("name") as string,
      nodeName: record.get("nodeName") ?? undefined,
      state: record.get("state") ?? undefined,
      agentAvailable: record.get("agentAvailable") ?? undefined,
      vmKind: record.get("vmKind") ?? undefined,
    }));
  }

  async vmsWithoutAgent(vmKind: VmKind = "qemu"): Promise<ClusterVmSummary[]> {
    const result = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType})
        WHERE coalesce(vm.agentAvailable, false) = false
          AND ($vmKind IS NULL OR toLower(coalesce(vm.vmKind, 'qemu')) = toLower($vmKind))
        OPTIONAL MATCH (vm)-[:RUNS_ON]->(n:TwinEntity {type: $nodeType})
        RETURN vm.id AS id,
               coalesce(vm.displayName, vm.id) AS name,
               vm.state AS state,
               n.displayName AS nodeName,
               vm.vmKind AS vmKind
        ORDER BY name
      `,
      {
        nodeType: "compute_node",
        vmType: "compute_vm",
        vmKind,
      }
    );

    return result.records.map((record) => ({
      id: record.get("id") as string,
      name: record.get("name") as string,
      nodeName: record.get("nodeName") ?? undefined,
      state: record.get("state") ?? undefined,
      agentAvailable: false,
      vmKind: record.get("vmKind") ?? undefined,
    }));
  }

  async stoppedVmsOnNode(
    nodeName: string,
    options: { vmKind?: VmKind } = {}
  ): Promise<ClusterVmSummary[]> {
    const vmKind = options.vmKind === undefined ? "qemu" : options.vmKind;
    const result = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType})-[:RUNS_ON]->(n:TwinEntity {type: $nodeType})
        WHERE toLower(n.displayName) = toLower($nodeName)
          AND toLower(coalesce(vm.state, "")) = "stopped"
          AND ($vmKind IS NULL OR toLower(coalesce(vm.vmKind, 'qemu')) = toLower($vmKind))
        RETURN vm.id AS id,
               coalesce(vm.displayName, vm.id) AS name,
               vm.state AS state,
               vm.agentAvailable AS agentAvailable,
               n.displayName AS nodeName,
               vm.vmKind AS vmKind
        ORDER BY name
      `,
      {
        nodeName,
        nodeType: "compute_node",
        vmType: "compute_vm",
        vmKind,
      }
    );

    return result.records.map((record) => ({
      id: record.get("id") as string,
      name: record.get("name") as string,
      nodeName: record.get("nodeName") ?? undefined,
      state: record.get("state") ?? undefined,
      agentAvailable: record.get("agentAvailable") ?? undefined,
      vmKind: record.get("vmKind") ?? undefined,
    }));
  }

  /**
   * Find VM by name across all nodes (case-insensitive partial match)
   * Verifies VMs exist in Proxmox before returning to avoid stale Neo4j data
   */
  async findVmByName(
    vmName: string,
    options: { vmKind?: VmKind; verifyAgainstProxmox?: boolean } = {}
  ): Promise<ClusterVmSummary[]> {
    // Default to searching ALL VM kinds (QEMU + LXC) when vmKind is not specified.
    // Callers that want to restrict to a specific kind should pass vmKind explicitly.
    const vmKind = options.vmKind === undefined ? null : options.vmKind;
    const verifyAgainstProxmox = options.verifyAgainstProxmox !== false; // Default to true
    
    const result = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType})
        WHERE toLower(coalesce(vm.displayName, vm.id, "")) CONTAINS toLower($vmName)
          AND ($vmKind IS NULL OR toLower(coalesce(vm.vmKind, 'qemu')) = toLower($vmKind))
        OPTIONAL MATCH (vm)-[:RUNS_ON]->(n:TwinEntity {type: $nodeType})
        RETURN vm.id AS id,
               coalesce(vm.displayName, vm.id) AS name,
               vm.state AS state,
               vm.agentAvailable AS agentAvailable,
               n.displayName AS nodeName,
               vm.vmKind AS vmKind
        ORDER BY 
          CASE 
            WHEN toLower(coalesce(vm.displayName, vm.id)) = toLower($vmName) THEN 0
            WHEN toLower(coalesce(vm.displayName, vm.id)) STARTS WITH toLower($vmName) THEN 1
            ELSE 2
          END,
          name
        LIMIT 10
      `,
      {
        vmName,
        nodeType: "compute_node",
        vmType: "compute_vm",
        vmKind,
      }
    );

    const neo4jVms = result.records.map((record) => ({
      id: record.get("id") as string,
      name: record.get("name") as string,
      nodeName: record.get("nodeName") ?? undefined,
      state: record.get("state") ?? undefined,
      agentAvailable: record.get("agentAvailable") ?? undefined,
      vmKind: record.get("vmKind") ?? undefined,
    }));

    // If no VMs found in Neo4j, return empty array
    if (neo4jVms.length === 0) {
      return [];
    }

    // Verify against Proxmox if enabled (default)
    if (verifyAgainstProxmox) {
      try {
        const verifiedVms = await this.verifyVmsAgainstProxmox(neo4jVms);
        // If verification returns empty but we had Neo4j results, be lenient and return Neo4j results
        // This handles cases where verification fails due to timing, API issues, or SSL problems
        if (verifiedVms.length === 0 && neo4jVms.length > 0) {
          logger.warn("Verification returned no VMs but Neo4j has results, returning Neo4j results (verification may have failed)", {
            vmName,
            neo4jCount: neo4jVms.length,
          });
          return neo4jVms;
        }
        return verifiedVms;
      } catch (error: any) {
        // If verification fails, log warning but return Neo4j results
        // This allows the system to continue even if Proxmox is unavailable
        logger.warn("Failed to verify VMs against Proxmox, returning Neo4j results", {
          error: error.message,
          vmName,
          neo4jCount: neo4jVms.length,
        });
        return neo4jVms;
      }
    }

    return neo4jVms;
  }

  /**
   * Find VM by ID across all nodes (handles ambiguity when same ID exists on multiple nodes/types)
   * Returns all VMs with the matching ID, showing node and type for disambiguation
   */
  async findVmById(
    vmId: number | string,
    options: { verifyAgainstProxmox?: boolean } = {}
  ): Promise<ClusterVmSummary[]> {
    const numericId = typeof vmId === "string" ? parseInt(vmId, 10) : vmId;
    if (isNaN(numericId)) {
      return [];
    }

    const verifyAgainstProxmox = options.verifyAgainstProxmox !== false;
    
    // Search for VMs where the ID ends with :{vmId}
    const result = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType})
        WHERE vm.id ENDS WITH $vmIdSuffix
        OPTIONAL MATCH (vm)-[:RUNS_ON]->(n:TwinEntity {type: $nodeType})
        RETURN vm.id AS id,
               coalesce(vm.displayName, vm.id) AS name,
               vm.state AS state,
               vm.agentAvailable AS agentAvailable,
               n.displayName AS nodeName,
               vm.vmKind AS vmKind
        ORDER BY n.displayName, vm.vmKind, name
      `,
      {
        vmIdSuffix: `:${numericId}`,
        nodeType: "compute_node",
        vmType: "compute_vm",
      }
    );

    const neo4jVms = result.records.map((record) => ({
      id: record.get("id") as string,
      name: record.get("name") as string,
      nodeName: record.get("nodeName") ?? undefined,
      state: record.get("state") ?? undefined,
      agentAvailable: record.get("agentAvailable") ?? undefined,
      vmKind: record.get("vmKind") ?? undefined,
    }));

    if (neo4jVms.length === 0) {
      return [];
    }

    // Deduplicate: if multiple entries have the same ID (node+type+vmId), keep only the first one
    const seenIds = new Set<string>();
    const deduplicatedVms = neo4jVms.filter((vm) => {
      if (seenIds.has(vm.id)) {
        logger.debug("Deduplicating VM entry", { vmId: numericId, duplicateId: vm.id });
        return false;
      }
      seenIds.add(vm.id);
      return true;
    });

    // Verify against Proxmox if enabled
    if (verifyAgainstProxmox) {
      try {
        const verifiedVms = await this.verifyVmsAgainstProxmox(deduplicatedVms);
        if (verifiedVms.length === 0 && deduplicatedVms.length > 0) {
          logger.warn("Verification returned no VMs but Neo4j has results, returning Neo4j results", {
            vmId: numericId,
            neo4jCount: deduplicatedVms.length,
          });
          return deduplicatedVms;
        }
        return verifiedVms;
      } catch (error: any) {
        logger.warn("Failed to verify VMs against Proxmox, returning Neo4j results", {
          error: error.message,
          vmId: numericId,
        });
        return deduplicatedVms;
      }
    }

    return deduplicatedVms;
  }

  /**
   * Verify VMs from Neo4j actually exist in Proxmox
   * Returns only VMs that exist in Proxmox, filters out stale entries
   */
  private async verifyVmsAgainstProxmox(
    neo4jVms: ClusterVmSummary[]
  ): Promise<ClusterVmSummary[]> {
    const configs = getProxmoxEndpointConfigs();
    if (configs.length === 0) {
      logger.warn("Proxmox credentials not configured, skipping verification", {
        hint: "Set cluster (PROXMOX_*/CLUSTER_TF_*) and/or proxbig (PROXBIG_*) env",
      });
      return neo4jVms;
    }

    try {
      const allProxmoxVms: Array<{ vmid: number; node?: string; type?: string; name?: string }> = [];
      for (const c of configs) {
        try {
          const client = new ProxmoxClient({
            url: c.url,
            tokenId: c.tokenId,
            tokenSecret: c.tokenSecret,
            verifySsl: c.verifySsl,
          });
          const resourcesResult = await client.get("/cluster/resources");
          const resources = resourcesResult.data?.data || [];
          const vmsInCluster = resources.filter((r: { type?: string }) => r.type === "qemu" || r.type === "lxc");
          logger.debug(`Proxmox resources from ${c.label}`, {
            url: c.url,
            totalResources: resources.length,
            vmResources: vmsInCluster.length,
          });
          allProxmoxVms.push(...vmsInCluster);
        } catch (err: unknown) {
          logger.debug(`Failed to query Proxmox ${c.label}`, {
            url: c.url,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const proxmoxVms = allProxmoxVms;
      logger.debug("Combined Proxmox VM resources from all endpoints", {
        totalVms: proxmoxVms.length,
        endpointsChecked: configs.length,
        sampleVmids: proxmoxVms.slice(0, 10).map((r) => ({ vmid: r.vmid, node: r.node, name: r.name })),
      });

      // Extract VMID from Neo4j VM IDs (format: "compute-vm:node:vmid")
      const verifiedVms: ClusterVmSummary[] = [];
      const staleVmIds: string[] = [];

      for (const neo4jVm of neo4jVms) {
        // Parse VMID from Neo4j ID (format: "compute-vm:node:vmid" or just "vmid")
        const vmid = this.parseVmNumericId(neo4jVm.id);

        if (!vmid || isNaN(vmid)) {
          logger.warn("Could not parse VMID from Neo4j ID", { id: neo4jVm.id, name: neo4jVm.name });
          // If we can't parse VMID, include it anyway (might be a different format)
          verifiedVms.push(neo4jVm);
          continue;
        }

        // Check if VM exists in Proxmox
        // First, find all resources with matching VMID (only check VMs/containers)
        const matchingResources = proxmoxVms.filter((r) => r.vmid === vmid);
        
        if (matchingResources.length === 0) {
          staleVmIds.push(neo4jVm.id);
          logger.debug("VM not found in Proxmox (stale Neo4j entry)", {
            id: neo4jVm.id,
            name: neo4jVm.name,
            vmid,
            nodeName: neo4jVm.nodeName,
            availableVmids: proxmoxVms
              .filter((r) => r.type === "qemu" || r.type === "lxc")
              .map((r) => ({ vmid: r.vmid, node: r.node, type: r.type }))
              .slice(0, 10),
          });
          continue;
        }
        
        const vmExists = matchingResources.some((r) => {
          const matchesType = !neo4jVm.vmKind || r.type === neo4jVm.vmKind;
          // Node matching: be flexible - allow case-insensitive match and handle undefined nodeName
          const matchesNode = !neo4jVm.nodeName || 
            !r.node || 
            r.node?.toLowerCase() === neo4jVm.nodeName.toLowerCase();
          return matchesType && matchesNode;
        });
        
        if (vmExists) {
          // VM exists with matching node/type
          verifiedVms.push(neo4jVm);
        } else if (matchingResources.length > 0) {
          logger.debug("VM found in Proxmox but node/type mismatch, including anyway", {
            vmid,
            neo4jNode: neo4jVm.nodeName,
            proxmoxNodes: matchingResources.map((r) => r.node),
            neo4jType: neo4jVm.vmKind,
            proxmoxTypes: matchingResources.map((r) => r.type),
          });
          verifiedVms.push(neo4jVm);
        }
      }

      if (staleVmIds.length > 0) {
        logger.info("Filtered out stale VMs from Neo4j", {
          staleCount: staleVmIds.length,
          verifiedCount: verifiedVms.length,
          staleIds: staleVmIds,
        });
      }

      // Deduplicate verified VMs by ID (in case verification created duplicates)
      const seenIds = new Set<string>();
      const deduplicatedVerifiedVms = verifiedVms.filter((vm) => {
        if (seenIds.has(vm.id)) {
          logger.debug("Deduplicating verified VM entry", { duplicateId: vm.id, name: vm.name });
          return false;
        }
        seenIds.add(vm.id);
        return true;
      });

      return deduplicatedVerifiedVms;
    } catch (err: unknown) {
      logger.error("Error verifying VMs against Proxmox", {
        error: err instanceof Error ? err.message : String(err),
        vmCount: neo4jVms.length,
      });
      return neo4jVms;
    }
  }

  /**
   * Clean stale VMs from Neo4j that no longer exist in Proxmox
   * Returns count of deleted VMs
   */
  async cleanStaleVms(): Promise<{ deleted: number; errors: number }> {
    const configs = getProxmoxEndpointConfigs();
    if (configs.length === 0) {
      throw new Error(
        "Proxmox credentials not configured. Set cluster (PROXMOX_*/CLUSTER_TF_*) and/or proxbig (PROXBIG_*) env."
      );
    }

    let deleted = 0;
    let errors = 0;

    try {
      const allVmsResult = await this.runQuery(
        `
          MATCH (vm:TwinEntity {type: $vmType})
          OPTIONAL MATCH (vm)-[:RUNS_ON]->(n:TwinEntity {type: $nodeType})
          RETURN vm.id AS id,
                 coalesce(vm.displayName, vm.id) AS name,
                 n.displayName AS nodeName,
                 vm.vmKind AS vmKind
        `,
        {
          vmType: "compute_vm",
          nodeType: "compute_node",
        }
      );

      const neo4jVms = allVmsResult.records.map((record) => ({
        id: record.get("id") as string,
        name: record.get("name") as string,
        nodeName: record.get("nodeName") ?? undefined,
        vmKind: record.get("vmKind") ?? undefined,
      }));

      if (neo4jVms.length === 0) {
        logger.info("No VMs found in Neo4j to clean");
        return { deleted: 0, errors: 0 };
      }

      const proxmoxResources: Array<{ vmid?: number; node?: string; type?: string }> = [];
      for (const c of configs) {
        try {
          const client = new ProxmoxClient({
            url: c.url,
            tokenId: c.tokenId,
            tokenSecret: c.tokenSecret,
            verifySsl: c.verifySsl,
          });
          const resourcesResult = await client.get("/cluster/resources");
          const data = resourcesResult.data?.data || [];
          proxmoxResources.push(...data);
        } catch (err: unknown) {
          logger.warn(`Failed to fetch Proxmox resources from ${c.label}`, {
            url: c.url,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Find stale VMs
      const staleVmIds: string[] = [];

      for (const neo4jVm of neo4jVms) {
        const vmid = this.parseVmNumericId(neo4jVm.id);

        if (!vmid || isNaN(vmid)) {
          continue; // Skip if we can't parse VMID
        }

        const vmExists = proxmoxResources.some((r) => {
          const matchesVmid = r.vmid === vmid;
          const matchesType = !neo4jVm.vmKind || r.type === neo4jVm.vmKind;
          const matchesNode = !neo4jVm.nodeName || 
            r.node?.toLowerCase() === neo4jVm.nodeName.toLowerCase();
          return matchesVmid && matchesType && matchesNode;
        });

        if (!vmExists) {
          staleVmIds.push(neo4jVm.id);
        }
      }

      // Delete stale VMs from Neo4j
      if (staleVmIds.length > 0) {
        logger.info("Deleting stale VMs from Neo4j", { count: staleVmIds.length, ids: staleVmIds });

        for (const staleId of staleVmIds) {
          try {
            await this.runQuery(
              `
                MATCH (vm:TwinEntity {id: $id})
                DETACH DELETE vm
              `,
              { id: staleId }
            );
            deleted++;
          } catch (error: any) {
            logger.error("Error deleting stale VM from Neo4j", {
              id: staleId,
              error: error.message,
            });
            errors++;
          }
        }
      } else {
        logger.info("No stale VMs found in Neo4j");
      }

      return { deleted, errors };
    } catch (error: any) {
      logger.error("Error cleaning stale VMs", { error: error.message });
      throw error;
    }
  }

  /**
   * List all firewall rules.
   */
  async listFirewallRules(): Promise<Array<{
    id: string;
    action: string;
    direction?: string;
    interface?: string;
    protocol?: string;
    source?: string;
    destination?: string;
    chain?: string;
  }>> {
    const result = await this.runQuery(
      `
        MATCH (r:TwinEntity {type: $ruleType})
        RETURN r.id AS id,
               r.action AS action,
               r.direction AS direction,
               r.interface AS interface,
               r.protocol AS protocol,
               r.source AS source,
               r.destination AS destination,
               r.chain AS chain
        ORDER BY r.chain, r.action, r.direction
      `,
      { ruleType: "firewall_rule" }
    );

    return result.records.map((record) => ({
      id: record.get("id") as string,
      action: record.get("action") as string,
      direction: record.get("direction") ?? undefined,
      interface: record.get("interface") ?? undefined,
      protocol: record.get("protocol") ?? undefined,
      source: record.get("source") ?? undefined,
      destination: record.get("destination") ?? undefined,
      chain: record.get("chain") ?? undefined,
    }));
  }

  /**
   * List firewall alias definitions (name -> entries/cidrs) for use in agent responses.
   */
  async listFirewallAliases(): Promise<Array<{ name: string; type?: string; entries: string[]; cidrs: string[] }>> {
    const result = await this.runQuery(
      `
        MATCH (a:TwinEntity {type: $aliasType})
        RETURN a.id AS id,
               coalesce(a.displayName, a.aliasName) AS name,
               a.aliasType AS type,
               a.dataJson AS dataJson
        ORDER BY name
      `,
      { aliasType: "firewall_alias" }
    );

    return result.records.map((record) => {
      const name = (record.get("name") as string) ?? (record.get("id") as string)?.replace(/^firewall-alias:/i, "") ?? "unknown";
      let entries: string[] = [];
      let cidrs: string[] = [];
      try {
        const dataJson = record.get("dataJson");
        const data = typeof dataJson === "string" ? JSON.parse(dataJson) : dataJson;
        if (data && typeof data === "object") {
          entries = Array.isArray(data.entries) ? data.entries : [];
          cidrs = Array.isArray(data.cidrs) ? data.cidrs : [];
        }
      } catch {
        // ignore
      }
      return {
        name,
        type: record.get("type") as string | undefined,
        entries,
        cidrs,
      };
    });
  }

  /**
   * List firewall rules by interface/chain.
   */
  async firewallRulesByChain(chain: string): Promise<Array<{
    id: string;
    action: string;
    direction?: string;
    protocol?: string;
    source?: string;
    destination?: string;
  }>> {
    const result = await this.runQuery(
      `
        MATCH (r:TwinEntity {type: $ruleType})
        WHERE r.chain = $chain
        RETURN r.id AS id,
               r.action AS action,
               r.direction AS direction,
               r.protocol AS protocol,
               r.source AS source,
               r.destination AS destination
        ORDER BY r.action, r.direction
      `,
      { ruleType: "firewall_rule", chain }
    );

    return result.records.map((record) => ({
      id: record.get("id") as string,
      action: record.get("action") as string,
      direction: record.get("direction") ?? undefined,
      protocol: record.get("protocol") ?? undefined,
      source: record.get("source") ?? undefined,
      destination: record.get("destination") ?? undefined,
    }));
  }

  /**
   * Find rules that ALLOW access to a subnet.
   * Matches by exact CIDR or by mask pattern (e.g., /22 matches any /22 subnet).
   */
  async rulesAllowingSubnet(subnetCidr: string): Promise<Array<{
    ruleId: string;
    action: string;
    direction?: string;
    protocol?: string;
    subnetId: string;
  }>> {
    const subnetId = `network-subnet:${subnetCidr.toLowerCase()}`;
    // Extract mask for pattern matching (e.g., "172.16.0.0/22" -> "/22")
    const maskMatch = subnetCidr.match(/\/(\d+)$/);
    const mask = maskMatch ? maskMatch[1] : null;
    
    const result = await this.runQuery(
      `
        MATCH (r:TwinEntity {type: $ruleType})-[:ALLOWS]->(s:TwinEntity {type: $subnetType})
        WHERE s.id = $subnetId 
           OR s.displayName = $subnetCidr
           OR (s.displayName ENDS WITH $maskPattern AND $mask IS NOT NULL)
           OR (s.id ENDS WITH $maskPattern AND $mask IS NOT NULL)
        RETURN r.id AS ruleId,
               r.action AS action,
               r.direction AS direction,
               r.protocol AS protocol,
               s.id AS subnetId,
               s.displayName AS subnetCidr
        ORDER BY r.action, r.direction
      `,
      {
        ruleType: "firewall_rule",
        subnetType: "network_subnet",
        subnetId,
        subnetCidr,
        maskPattern: mask ? `/${mask}` : null,
        mask,
      }
    );

    return result.records.map((record) => ({
      ruleId: record.get("ruleId") as string,
      action: record.get("action") as string,
      direction: record.get("direction") ?? undefined,
      protocol: record.get("protocol") ?? undefined,
      subnetId: record.get("subnetId") as string,
    }));
  }

  /**
   * Find rules that BLOCK access to a subnet.
   * Matches by exact CIDR or by mask pattern (e.g., /22 matches any /22 subnet).
   */
  async rulesBlockingSubnet(subnetCidr: string): Promise<Array<{
    ruleId: string;
    action: string;
    direction?: string;
    protocol?: string;
    subnetId: string;
  }>> {
    const subnetId = `network-subnet:${subnetCidr.toLowerCase()}`;
    // Extract mask for pattern matching (e.g., "172.16.0.0/22" -> "/22")
    const maskMatch = subnetCidr.match(/\/(\d+)$/);
    const mask = maskMatch ? maskMatch[1] : null;
    
    const result = await this.runQuery(
      `
        MATCH (r:TwinEntity {type: $ruleType})-[:BLOCKS]->(s:TwinEntity {type: $subnetType})
        WHERE s.id = $subnetId 
           OR s.displayName = $subnetCidr
           OR (s.displayName ENDS WITH $maskPattern AND $mask IS NOT NULL)
           OR (s.id ENDS WITH $maskPattern AND $mask IS NOT NULL)
        RETURN r.id AS ruleId,
               r.action AS action,
               r.direction AS direction,
               r.protocol AS protocol,
               s.id AS subnetId,
               s.displayName AS subnetCidr
        ORDER BY r.action, r.direction
      `,
      {
        ruleType: "firewall_rule",
        subnetType: "network_subnet",
        subnetId,
        subnetCidr,
        maskPattern: mask ? `/${mask}` : null,
        mask,
      }
    );

    return result.records.map((record) => ({
      ruleId: record.get("ruleId") as string,
      action: record.get("action") as string,
      direction: record.get("direction") ?? undefined,
      protocol: record.get("protocol") ?? undefined,
      subnetId: record.get("subnetId") as string,
      subnetCidr: record.get("subnetCidr") ?? undefined,
    }));
  }

  /**
   * Get exposure map: which VMs are reachable based on firewall rules and subnet membership.
   */
  async exposureMap(vmId?: string): Promise<Array<{
    vmId: string;
    vmName: string;
    subnet: string;
    subnetId: string;
    allowedBy: string[];
    blockedBy: string[];
  }>> {
    const vmFilter = vmId ? "AND vm.id = $vmId" : "";
    const result = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType})
        MATCH (iface:TwinEntity {type: $ifaceType})
        WHERE iface.vmId = vm.id ${vmFilter}
        MATCH (iface)-[:CONNECTS_TO]->(subnet:TwinEntity {type: $subnetType})
        OPTIONAL MATCH (allowRule:TwinEntity {type: $ruleType})-[:ALLOWS]->(subnet)
        OPTIONAL MATCH (blockRule:TwinEntity {type: $ruleType})-[:BLOCKS]->(subnet)
        RETURN vm.id AS vmId,
               coalesce(vm.displayName, vm.id) AS vmName,
               subnet.displayName AS subnet,
               subnet.id AS subnetId,
               collect(DISTINCT allowRule.id) AS allowedBy,
               collect(DISTINCT blockRule.id) AS blockedBy
        ORDER BY vmName
      `,
      {
        vmType: "compute_vm",
        ifaceType: "network_interface",
        subnetType: "network_subnet",
        ruleType: "firewall_rule",
        ...(vmId ? { vmId } : {}),
      }
    );

    return result.records.map((record) => ({
      vmId: record.get("vmId") as string,
      vmName: record.get("vmName") as string,
      subnet: record.get("subnet") as string,
      subnetId: record.get("subnetId") as string,
      allowedBy: (record.get("allowedBy")?.toArray?.() || record.get("allowedBy") || []).filter((x: any) => x),
      blockedBy: (record.get("blockedBy")?.toArray?.() || record.get("blockedBy") || []).filter((x: any) => x),
    }));
  }

  async reachableFromSubnet(
    subnetCidr: string,
    vmId?: string
  ): Promise<Array<{
    vmId: string;
    vmName: string;
    subnet: string;
    subnetId: string;
    allowedBy: string[];
    blockedBy: string[];
  }>> {
    const subnetId = `network-subnet:${subnetCidr.toLowerCase()}`;
    const vmFilter = vmId ? "AND vm.id = $vmId" : "";
    const result = await this.runQuery(
      `
        MATCH (subnet:TwinEntity {type: $subnetType})
        WHERE subnet.id = $subnetId OR subnet.displayName = $subnetCidr
        MATCH (iface:TwinEntity {type: $ifaceType})-[:CONNECTS_TO]->(subnet)
        MATCH (vm:TwinEntity {type: $vmType})
        WHERE iface.vmId = vm.id ${vmFilter}
        OPTIONAL MATCH (allowRule:TwinEntity {type: $ruleType})-[:ALLOWS]->(subnet)
        OPTIONAL MATCH (blockRule:TwinEntity {type: $ruleType})-[:BLOCKS]->(subnet)
        RETURN vm.id AS vmId,
               coalesce(vm.displayName, vm.id) AS vmName,
               subnet.displayName AS subnet,
               subnet.id AS subnetId,
               collect(DISTINCT allowRule.id) AS allowedBy,
               collect(DISTINCT blockRule.id) AS blockedBy
        ORDER BY vmName
      `,
      {
        subnetType: "network_subnet",
        ifaceType: "network_interface",
        vmType: "compute_vm",
        ruleType: "firewall_rule",
        subnetId,
        subnetCidr,
        ...(vmId ? { vmId } : {}),
      }
    );

    return result.records.map((record) => ({
      vmId: record.get("vmId") as string,
      vmName: record.get("vmName") as string,
      subnet: record.get("subnet") as string,
      subnetId: record.get("subnetId") as string,
      allowedBy: (record.get("allowedBy")?.toArray?.() || record.get("allowedBy") || []).filter((x: any) => x),
      blockedBy: (record.get("blockedBy")?.toArray?.() || record.get("blockedBy") || []).filter((x: any) => x),
    }));
  }

  async reachableFromInterfaceChain(
    chain: string
  ): Promise<Array<{
    vmId: string;
    vmName: string;
    subnet: string;
    subnetId: string;
    allowedBy: string[];
    blockedBy: string[];
  }>> {
    const result = await this.runQuery(
      `
        MATCH (allowRule:TwinEntity {type: $ruleType, chain: $chain})-[:ALLOWS]->(subnet:TwinEntity {type: $subnetType})
        OPTIONAL MATCH (blockRule:TwinEntity {type: $ruleType, chain: $chain})-[:BLOCKS]->(subnet)
        MATCH (iface:TwinEntity {type: $ifaceType})-[:CONNECTS_TO]->(subnet)
        MATCH (vm:TwinEntity {type: $vmType})
        WHERE iface.vmId = vm.id
        RETURN vm.id AS vmId,
               coalesce(vm.displayName, vm.id) AS vmName,
               subnet.displayName AS subnet,
               subnet.id AS subnetId,
               collect(DISTINCT allowRule.id) AS allowedBy,
               collect(DISTINCT blockRule.id) AS blockedBy
        ORDER BY vmName
      `,
      {
        ruleType: "firewall_rule",
        subnetType: "network_subnet",
        ifaceType: "network_interface",
        vmType: "compute_vm",
        chain,
      }
    );

    return result.records.map((record) => ({
      vmId: record.get("vmId") as string,
      vmName: record.get("vmName") as string,
      subnet: record.get("subnet") as string,
      subnetId: record.get("subnetId") as string,
      allowedBy: (record.get("allowedBy")?.toArray?.() || record.get("allowedBy") || []).filter((x: any) => x),
      blockedBy: (record.get("blockedBy")?.toArray?.() || record.get("blockedBy") || []).filter((x: any) => x),
    }));
  }

  async ruleImpact(ruleId: string): Promise<{
    ruleId: string;
    action?: string;
    direction?: string;
    protocol?: string;
    subnets: Array<{
      subnetId: string;
      subnet: string;
      vms: Array<{ vmId: string; vmName: string }>;
    }>;
  }> {
    const result = await this.runQuery(
      `
        MATCH (r:TwinEntity {type: $ruleType, id: $ruleId})
        OPTIONAL MATCH (r)-[:ALLOWS|:BLOCKS]->(subnet:TwinEntity {type: $subnetType})
        OPTIONAL MATCH (iface:TwinEntity {type: $ifaceType})-[:CONNECTS_TO]->(subnet)
        OPTIONAL MATCH (vm:TwinEntity {type: $vmType})
        WHERE iface.vmId = vm.id
        RETURN r.id AS ruleId,
               r.action AS action,
               r.direction AS direction,
               r.protocol AS protocol,
               subnet.id AS subnetId,
               subnet.displayName AS subnet,
               collect(DISTINCT vm.id) AS vmIds,
               collect(DISTINCT coalesce(vm.displayName, vm.id)) AS vmNames
      `,
      {
        ruleType: "firewall_rule",
        subnetType: "network_subnet",
        ifaceType: "network_interface",
        vmType: "compute_vm",
        ruleId,
      }
    );

    if (!result.records.length) {
      return {
        ruleId,
        subnets: [],
      };
    }

    const subnets = result.records
      .filter((record) => record.get("subnetId"))
      .map((record) => {
        const vmIds = (record.get("vmIds")?.toArray?.() || record.get("vmIds") || []) as string[];
        const vmNames = (record.get("vmNames")?.toArray?.() || record.get("vmNames") || []) as string[];
        const vms = vmIds.map((vmId, index) => ({
          vmId,
          vmName: vmNames[index] ?? vmId,
        }));
        return {
          subnetId: record.get("subnetId") as string,
          subnet: record.get("subnet") as string,
          vms,
        };
      });

    const first = result.records[0];
    if (!first) {
      return {
        ruleId,
        subnets: [],
      };
    }
    return {
      ruleId: first.get("ruleId") as string,
      action: first.get("action") ?? undefined,
      direction: first.get("direction") ?? undefined,
      protocol: first.get("protocol") ?? undefined,
      subnets,
    };
  }

  /**
   * Analyze full exposure for a specific VM.
   * Returns interfaces, subnets, and all firewall rules affecting it.
   */
  async vmExposure(vmId: string): Promise<{
    vmId: string;
    vmName: string;
    nodeName?: string;
    interfaces: Array<{
      interfaceId: string;
      interfaceName: string;
      subnet: string;
      subnetId: string;
      allowedBy: Array<{
        ruleId: string;
        action: string;
        direction?: string;
        protocol?: string;
      }>;
      blockedBy: Array<{
        ruleId: string;
        action: string;
        direction?: string;
        protocol?: string;
      }>;
    }>;
    exposureLevel: "high" | "medium" | "low" | "none";
  }> {
    const result = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType, id: $vmId})
        OPTIONAL MATCH (vm)-[:RUNS_ON]->(node:TwinEntity {type: $nodeType})
        MATCH (iface:TwinEntity {type: $ifaceType})
        WHERE iface.vmId = vm.id
        OPTIONAL MATCH (iface)-[:CONNECTS_TO]->(subnet:TwinEntity {type: $subnetType})
        OPTIONAL MATCH (allowRule:TwinEntity {type: $ruleType})-[:ALLOWS]->(subnet)
        OPTIONAL MATCH (blockRule:TwinEntity {type: $ruleType})-[:BLOCKS]->(subnet)
        RETURN vm.id AS vmId,
               coalesce(vm.displayName, vm.id) AS vmName,
               node.displayName AS nodeName,
               iface.id AS interfaceId,
               iface.dataJson AS interfaceData,
               subnet.id AS subnetId,
               subnet.displayName AS subnetCidr,
               allowRule.id AS allowRuleId,
               allowRule.action AS allowAction,
               allowRule.direction AS allowDirection,
               allowRule.protocol AS allowProtocol,
               blockRule.id AS blockRuleId,
               blockRule.action AS blockAction,
               blockRule.direction AS blockDirection,
               blockRule.protocol AS blockProtocol
        ORDER BY iface.id, subnet.id
      `,
      {
        vmType: "compute_vm",
        nodeType: "compute_node",
        ifaceType: "network_interface",
        subnetType: "network_subnet",
        ruleType: "firewall_rule",
        vmId,
      }
    );

    const vmName = result.records[0]?.get("vmName") as string || vmId;
    const nodeName = result.records[0]?.get("nodeName") as string | undefined;

    // Group by interface
    const interfaceMap = new Map<string, any>();
    for (const record of result.records) {
      const ifaceId = record.get("interfaceId") as string;
      if (!ifaceId) continue;

      if (!interfaceMap.has(ifaceId)) {
        const ifaceData = JSON.parse(record.get("interfaceData") || "{}");
        interfaceMap.set(ifaceId, {
          interfaceId: ifaceId,
          interfaceName: ifaceData.name || ifaceId.split(":").pop() || "unknown",
          subnet: record.get("subnetCidr") as string | null,
          subnetId: record.get("subnetId") as string | null,
          allowedBy: [],
          blockedBy: [],
        });
      }

      const iface = interfaceMap.get(ifaceId)!;
      const subnetId = record.get("subnetId") as string;
      if (subnetId && subnetId === iface.subnetId) {
        const allowRuleId = record.get("allowRuleId");
        if (allowRuleId) {
          iface.allowedBy.push({
            ruleId: allowRuleId,
            action: record.get("allowAction"),
            direction: record.get("allowDirection"),
            protocol: record.get("allowProtocol"),
          });
        }
        const blockRuleId = record.get("blockRuleId");
        if (blockRuleId) {
          iface.blockedBy.push({
            ruleId: blockRuleId,
            action: record.get("blockAction"),
            direction: record.get("blockDirection"),
            protocol: record.get("blockProtocol"),
          });
        }
      }
    }

    const interfaces = Array.from(interfaceMap.values());
    
    // Calculate exposure level
    let exposureLevel: "high" | "medium" | "low" | "none" = "none";
    const totalAllows = interfaces.reduce((sum, iface) => sum + iface.allowedBy.length, 0);
    const totalBlocks = interfaces.reduce((sum, iface) => sum + iface.blockedBy.length, 0);
    
    if (totalAllows > 0) {
      if (totalAllows > totalBlocks * 2) {
        exposureLevel = "high";
      } else if (totalAllows > totalBlocks) {
        exposureLevel = "medium";
      } else {
        exposureLevel = "low";
      }
    }

    return {
      vmId,
      vmName,
      nodeName,
      interfaces,
      exposureLevel,
    };
  }

  /**
   * Find VMs exposed to a specific subnet (e.g., WAN).
   */
  async vmsExposedToSubnet(subnetCidr: string): Promise<Array<{
    vmId: string;
    vmName: string;
    nodeName?: string;
    subnet: string;
    allowRules: number;
    blockRules: number;
  }>> {
    // Extract mask for pattern matching
    const maskMatch = subnetCidr.match(/\/(\d+)$/);
    const mask = maskMatch ? maskMatch[1] : null;
    const maskPattern = mask ? `/${mask}` : null;

    const result = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType})
        MATCH (iface:TwinEntity {type: $ifaceType})
        WHERE iface.vmId = vm.id
        MATCH (iface)-[:CONNECTS_TO]->(subnet:TwinEntity {type: $subnetType})
        WHERE subnet.displayName = $subnetCidr
           OR subnet.id = $subnetId
           OR (subnet.displayName ENDS WITH $maskPattern AND $mask IS NOT NULL)
        OPTIONAL MATCH (vm)-[:RUNS_ON]->(node:TwinEntity {type: $nodeType})
        OPTIONAL MATCH (allowRule:TwinEntity {type: $ruleType})-[:ALLOWS]->(subnet)
        OPTIONAL MATCH (blockRule:TwinEntity {type: $ruleType})-[:BLOCKS]->(subnet)
        RETURN DISTINCT vm.id AS vmId,
               coalesce(vm.displayName, vm.id) AS vmName,
               node.displayName AS nodeName,
               subnet.displayName AS subnet,
               count(DISTINCT allowRule) AS allowRules,
               count(DISTINCT blockRule) AS blockRules
        ORDER BY allowRules DESC, vmName
      `,
      {
        vmType: "compute_vm",
        nodeType: "compute_node",
        ifaceType: "network_interface",
        subnetType: "network_subnet",
        ruleType: "firewall_rule",
        subnetId: `network-subnet:${subnetCidr.toLowerCase()}`,
        subnetCidr,
        maskPattern,
        mask,
      }
    );

    return result.records.map((record) => ({
      vmId: record.get("vmId") as string,
      vmName: record.get("vmName") as string,
      nodeName: record.get("nodeName") ?? undefined,
      subnet: record.get("subnet") as string,
      allowRules: this.safeToNumber(record.get("allowRules")),
      blockRules: this.safeToNumber(record.get("blockRules")),
    }));
  }

  /**
   * Find attack path from source subnet to target VM.
   */
  async exposurePath(fromSubnetCidr: string, toVmId: string): Promise<{
    fromSubnet: string;
    toVm: string;
    toVmName: string;
    path: Array<{
      step: number;
      entityType: string;
      entityId: string;
      entityName: string;
      relationship: string;
    }>;
    reachable: boolean;
  }> {
    // Extract mask for pattern matching
    const maskMatch = fromSubnetCidr.match(/\/(\d+)$/);
    const mask = maskMatch ? maskMatch[1] : null;
    const maskPattern = mask ? `/${mask}` : null;

    const result = await this.runQuery(
      `
        MATCH (sourceSubnet:TwinEntity {type: $subnetType})
        WHERE sourceSubnet.displayName = $fromSubnetCidr
           OR sourceSubnet.id = $fromSubnetId
           OR (sourceSubnet.displayName ENDS WITH $maskPattern AND $mask IS NOT NULL)
        MATCH (targetVm:TwinEntity {type: $vmType, id: $toVmId})
        MATCH (targetIface:TwinEntity {type: $ifaceType})
        WHERE targetIface.vmId = targetVm.id
        MATCH (targetIface)-[:CONNECTS_TO]->(targetSubnet:TwinEntity {type: $subnetType})
        OPTIONAL MATCH path = shortestPath((sourceSubnet)-[:ALLOWS*..5]-(targetSubnet))
        RETURN sourceSubnet.displayName AS fromSubnet,
               targetVm.id AS toVm,
               coalesce(targetVm.displayName, targetVm.id) AS toVmName,
               path
        LIMIT 1
      `,
      {
        subnetType: "network_subnet",
        vmType: "compute_vm",
        ifaceType: "network_interface",
        fromSubnetId: `network-subnet:${fromSubnetCidr.toLowerCase()}`,
        fromSubnetCidr,
        toVmId,
        maskPattern,
        mask,
      }
    );

    if (result.records.length === 0) {
      // Try simpler path: source subnet → target subnet (if same)
      const simpleResult = await this.runQuery(
        `
          MATCH (sourceSubnet:TwinEntity {type: $subnetType})
          WHERE sourceSubnet.displayName = $fromSubnetCidr
             OR sourceSubnet.id = $fromSubnetId
             OR (sourceSubnet.displayName ENDS WITH $maskPattern AND $mask IS NOT NULL)
          MATCH (targetVm:TwinEntity {type: $vmType, id: $toVmId})
          MATCH (targetIface:TwinEntity {type: $ifaceType})
          WHERE targetIface.vmId = targetVm.id
          MATCH (targetIface)-[:CONNECTS_TO]->(targetSubnet:TwinEntity {type: $subnetType})
          WHERE targetSubnet.id = sourceSubnet.id
          RETURN sourceSubnet.displayName AS fromSubnet,
                 targetVm.id AS toVm,
                 coalesce(targetVm.displayName, targetVm.id) AS toVmName
          LIMIT 1
        `,
        {
          subnetType: "network_subnet",
          vmType: "compute_vm",
          ifaceType: "network_interface",
          fromSubnetId: `network-subnet:${fromSubnetCidr.toLowerCase()}`,
          fromSubnetCidr,
          toVmId,
          maskPattern,
          mask,
        }
      );

      if (simpleResult.records.length > 0) {
        const record = simpleResult.records[0];
        if (!record) {
          return {
            fromSubnet: fromSubnetCidr,
            toVm: toVmId,
            toVmName: toVmId,
            path: [],
            reachable: false,
          };
        }
        return {
          fromSubnet: record.get("fromSubnet") as string,
          toVm: record.get("toVm") as string,
          toVmName: record.get("toVmName") as string,
          path: [
            {
              step: 1,
              entityType: "network_subnet",
              entityId: `network-subnet:${fromSubnetCidr.toLowerCase()}`,
              entityName: fromSubnetCidr,
              relationship: "CONNECTS_TO",
            },
            {
              step: 2,
              entityType: "compute_vm",
              entityId: record.get("toVm") as string,
              entityName: record.get("toVmName") as string,
              relationship: "HAS_INTERFACE",
            },
          ],
          reachable: true,
        };
      }

      return {
        fromSubnet: fromSubnetCidr,
        toVm: toVmId,
        toVmName: toVmId,
        path: [],
        reachable: false,
      };
    }

    const record = result.records[0];
    if (!record) {
      return {
        fromSubnet: fromSubnetCidr,
        toVm: toVmId,
        toVmName: toVmId,
        path: [],
        reachable: false,
      };
    }
    const path = record.get("path");
    // TODO: Parse Neo4j path object into step array
    // For now, return simple path
    return {
      fromSubnet: record.get("fromSubnet") as string,
      toVm: record.get("toVm") as string,
      toVmName: record.get("toVmName") as string,
      path: [],
      reachable: true,
    };
  }

  /**
   * Find VMs with internet/WAN exposure.
   * Looks for VMs in subnets that have ALLOWS rules from WAN-like subnets.
   */
  async internetExposedVms(): Promise<Array<{
    vmId: string;
    vmName: string;
    nodeName?: string;
    subnet: string;
    exposureRules: number;
  }>> {
    const result = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType})
        MATCH (iface:TwinEntity {type: $ifaceType})
        WHERE iface.vmId = vm.id
        MATCH (iface)-[:CONNECTS_TO]->(subnet:TwinEntity {type: $subnetType})
        MATCH (allowRule:TwinEntity {type: $ruleType})-[:ALLOWS]->(subnet)
        WHERE allowRule.direction = 'in' OR allowRule.direction IS NULL
        OPTIONAL MATCH (vm)-[:RUNS_ON]->(node:TwinEntity {type: $nodeType})
        RETURN DISTINCT vm.id AS vmId,
               coalesce(vm.displayName, vm.id) AS vmName,
               node.displayName AS nodeName,
               subnet.displayName AS subnet,
               count(DISTINCT allowRule) AS exposureRules
        ORDER BY exposureRules DESC, vmName
      `,
      {
        vmType: "compute_vm",
        nodeType: "compute_node",
        ifaceType: "network_interface",
        subnetType: "network_subnet",
        ruleType: "firewall_rule",
      }
    );

    return result.records.map((record) => ({
      vmId: record.get("vmId") as string,
      vmName: record.get("vmName") as string,
      nodeName: record.get("nodeName") ?? undefined,
      subnet: record.get("subnet") as string,
      exposureRules: this.safeToNumber(record.get("exposureRules")),
    }));
  }

  private safeToNumber(value: any): number {
    if (value === null || value === undefined) {
      return 0;
    }
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "bigint") {
      return Number(value);
    }
    if (typeof value.toNumber === "function") {
      return value.toNumber();
    }
    const parsed = Number(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  private parseVmNumericId(entityId: string): number | null {
    const idParts = entityId.split(":");
    const vmIdPart = idParts[idParts.length - 1];
    if (!vmIdPart) {
      return null;
    }
    const parsed = parseInt(vmIdPart, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
}
