import neo4j from "neo4j-driver";
import { Neo4jGraphStore } from "../../pce/kg/indexation/neo4j-client";

interface ClusterNodeSummary {
  id: string;
  name: string;
  vmCount: number;
  status?: string;
}

interface ClusterVmSummary {
  id: string;
  name: string;
  nodeName?: string;
  state?: string;
  agentAvailable?: boolean;
}

export class TwinQueryService {
  private graphStore: Neo4jGraphStore;

  constructor(graphStore: Neo4jGraphStore = new Neo4jGraphStore()) {
    this.graphStore = graphStore;
  }

  private mapInterface(record: neo4j.Record): any {
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
  ): Promise<neo4j.QueryResult> {
    await this.ensureConnected();
    const session = this.graphStore.getDriver().session();
    try {
      return await session.run(query, params);
    } finally {
      await session.close();
    }
  }

  async describeCluster(): Promise<{
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
               count(vm) AS vmCount
        ORDER BY name
      `,
      { nodeType: "compute_node", vmType: "compute_vm" }
    );

    const nodes = nodesResult.records.map((record) => ({
      id: record.get("id") as string,
      name: record.get("name") as string,
      vmCount: this.safeToNumber(record.get("vmCount")),
      status: record.get("status") ?? undefined,
    }));

    const vmsResult = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType})
        OPTIONAL MATCH (vm)-[:RUNS_ON]->(n:TwinEntity {type: $nodeType})
        RETURN vm.id AS id,
               coalesce(vm.displayName, vm.id) AS name,
               vm.state AS state,
               vm.agentAvailable AS agentAvailable,
               n.displayName AS nodeName
        ORDER BY name
      `,
      { nodeType: "compute_node", vmType: "compute_vm" }
    );

    const vms = vmsResult.records.map((record) => ({
      id: record.get("id") as string,
      name: record.get("name") as string,
      nodeName: record.get("nodeName") ?? undefined,
      state: record.get("state") ?? undefined,
      agentAvailable: record.get("agentAvailable") ?? undefined,
    }));

    return { nodes, vms };
  }

  async vmsByNode(nodeName: string): Promise<ClusterVmSummary[]> {
    const result = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType})-[:RUNS_ON]->(n:TwinEntity {type: $nodeType})
        WHERE toLower(n.displayName) = toLower($nodeName)
        RETURN vm.id AS id,
               coalesce(vm.displayName, vm.id) AS name,
               vm.state AS state,
               vm.agentAvailable AS agentAvailable,
               n.displayName AS nodeName
        ORDER BY name
      `,
      {
        nodeName,
        nodeType: "compute_node",
        vmType: "compute_vm",
      }
    );

    return result.records.map((record) => ({
      id: record.get("id") as string,
      name: record.get("name") as string,
      nodeName: record.get("nodeName") ?? undefined,
      state: record.get("state") ?? undefined,
      agentAvailable: record.get("agentAvailable") ?? undefined,
    }));
  }

  async vmsWithoutAgent(): Promise<ClusterVmSummary[]> {
    const result = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType})
        OPTIONAL MATCH (vm)-[:RUNS_ON]->(n:TwinEntity {type: $nodeType})
        WHERE coalesce(vm.agentAvailable, false) = false
        RETURN vm.id AS id,
               coalesce(vm.displayName, vm.id) AS name,
               vm.state AS state,
               n.displayName AS nodeName
        ORDER BY name
      `,
      {
        nodeType: "compute_node",
        vmType: "compute_vm",
      }
    );

    return result.records.map((record) => ({
      id: record.get("id") as string,
      name: record.get("name") as string,
      nodeName: record.get("nodeName") ?? undefined,
      state: record.get("state") ?? undefined,
      agentAvailable: false,
    }));
  }

  async stoppedVmsOnNode(nodeName: string): Promise<ClusterVmSummary[]> {
    const result = await this.runQuery(
      `
        MATCH (vm:TwinEntity {type: $vmType})-[:RUNS_ON]->(n:TwinEntity {type: $nodeType})
        WHERE toLower(n.displayName) = toLower($nodeName)
          AND toLower(coalesce(vm.state, "")) = "stopped"
        RETURN vm.id AS id,
               coalesce(vm.displayName, vm.id) AS name,
               vm.state AS state,
               vm.agentAvailable AS agentAvailable,
               n.displayName AS nodeName
        ORDER BY name
      `,
      {
        nodeName,
        nodeType: "compute_node",
        vmType: "compute_vm",
      }
    );

    return result.records.map((record) => ({
      id: record.get("id") as string,
      name: record.get("name") as string,
      nodeName: record.get("nodeName") ?? undefined,
      state: record.get("state") ?? undefined,
      agentAvailable: record.get("agentAvailable") ?? undefined,
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
}

