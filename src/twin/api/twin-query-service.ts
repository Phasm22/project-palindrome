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

