import neo4j from "neo4j-driver";
import { Neo4jGraphStore } from "../../pce/kg/indexation/neo4j-client";

type VmKind = "qemu" | "lxc" | null;

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
  vmKind?: "qemu" | "lxc";
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

  async describeCluster(vmKind: VmKind = "qemu"): Promise<{
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
      allowedBy: (record.get("allowedBy")?.toArray?.() || record.get("allowedBy") || []).filter((x: any) => x),
      blockedBy: (record.get("blockedBy")?.toArray?.() || record.get("blockedBy") || []).filter((x: any) => x),
    }));
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
}

