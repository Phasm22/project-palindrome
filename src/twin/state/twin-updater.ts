import neo4j from "neo4j-driver";
import { Neo4jGraphStore } from "../../pce/kg/indexation/neo4j-client";
import type { TwinEntity } from "../models/entities";
import { TwinEntityType } from "../models/entities";
import type { TwinRelationship } from "../models/relationships";

export interface TwinUpdateOptions {
  createIndexes?: boolean;
}

export class TwinUpdateService {
  private initialized = false;

  constructor(private readonly graphStore: Neo4jGraphStore = new Neo4jGraphStore()) {}

  async initialize(options: TwinUpdateOptions = {}): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.graphStore.connect();
    if (options.createIndexes) {
      await this.graphStore.createIndexes();
    }
    this.initialized = true;
  }

  async upsert(
    entities: TwinEntity[],
    relationships: TwinRelationship[]
  ): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    await this.writeEntities(entities);
    await this.writeRelationships(relationships);
  }

  private async writeEntities(entities: TwinEntity[]): Promise<void> {
    if (!entities.length) {
      return;
    }

    const driver = this.graphStore.getDriver();
    const session = driver.session();
    try {
      for (const entity of entities) {
        const props = this.buildEntityProperties(entity);
        await session.run(
          `
            MERGE (n:TwinEntity {id: $id})
            SET n.type = $type,
                n.displayName = $displayName,
                n.entitySource = $entitySource,
                n.collectedAt = $collectedAt,
                n.dataJson = $dataJson,
                n.normalizedName = $normalizedName,
                n.status = $status,
                n.state = $state,
                n.agentAvailable = $agentAvailable,
                n.nodeId = $nodeId,
                n.nodeName = $nodeName,
                n.normalizedNodeName = $normalizedNodeName,
                n.vmId = $vmId,
                n.vmKind = $vmKind,
                n.primaryIp = $primaryIp,
                n.gateway = $gateway,
                n.cidr = $cidr,
                n.ips = $ips,
                n.action = $action,
                n.direction = $direction,
                n.interface = $interface,
                n.protocol = $protocol,
                n.source = $source,
                n.destination = $destination,
                n.chain = $chain,
                n.ruleType = $ruleType,
                n.aliasName = $aliasName,
                n.aliasType = $aliasType,
                n.aliasEntryCount = $aliasEntryCount,
                n.aliasCidrCount = $aliasCidrCount,
                n.hostname = $hostname,
                n.model = $model,
                n.role = $role,
                n.provenance = $provenance,
                n.managementIps = $managementIps,
                n.declaredTrunkPorts = $declaredTrunkPorts,
                n.declaredVlans = $declaredVlans,
                n.switchId = $switchId,
                n.portName = $portName,
                n.mode = $mode,
                n.accessVlan = $accessVlan,
                n.trunkVlans = $trunkVlans,
                n.portDescription = $portDescription
          `,
          {
            id: entity.id,
            type: entity.type,
            displayName: entity.displayName,
            entitySource: entity.source ?? null,
            collectedAt: neo4j.types.DateTime.fromStandardDate(entity.collectedAt),
            dataJson: props.dataJson,
            normalizedName: props.normalizedName,
            status: props.status,
            state: props.state,
            agentAvailable: props.agentAvailable,
            nodeId: props.nodeId,
            nodeName: props.nodeName,
            normalizedNodeName: props.normalizedNodeName,
            vmId: props.vmId,
            primaryIp: props.primaryIp,
            gateway: props.gateway,
            cidr: props.cidr,
            ips: props.ips,
            action: props.action,
            direction: props.direction,
            interface: props.interface,
            protocol: props.protocol,
            source: props.source,
            destination: props.destination,
            chain: props.chain,
            ruleType: props.ruleType,
            vmKind: props.vmKind,
            aliasName: props.aliasName,
            aliasType: props.aliasType,
            aliasEntryCount: props.aliasEntryCount,
            aliasCidrCount: props.aliasCidrCount,
            hostname: props.hostname,
            model: props.model,
            role: props.role,
            provenance: props.provenance,
            managementIps: props.managementIps,
            declaredTrunkPorts: props.declaredTrunkPorts,
            declaredVlans: props.declaredVlans,
            switchId: props.switchId,
            portName: props.portName,
            mode: props.mode,
            accessVlan: props.accessVlan,
            trunkVlans: props.trunkVlans,
            portDescription: props.portDescription,
          }
        );
      }
    } finally {
      await session.close();
    }
  }

  private async writeRelationships(relationships: TwinRelationship[]): Promise<void> {
    if (!relationships.length) {
      return;
    }

    const driver = this.graphStore.getDriver();
    const session = driver.session();
    let created = 0;
    let skipped = 0;
    try {
      for (const rel of relationships) {
        if (!rel.fromId || !rel.toId) {
          skipped++;
          continue;
        }
        // Check if both nodes exist before creating relationship
        const fromCheck = await session.run(
          `MATCH (a:TwinEntity {id: $fromId}) RETURN count(a) as count`,
          { fromId: rel.fromId }
        );
        const toCheck = await session.run(
          `MATCH (b:TwinEntity {id: $toId}) RETURN count(b) as count`,
          { toId: rel.toId }
        );

        const fromExists = fromCheck.records[0]?.get("count")?.toNumber() > 0;
        const toExists = toCheck.records[0]?.get("count")?.toNumber() > 0;

        if (!fromExists || !toExists) {
          skipped++;
          continue;
        }

        await session.run(
          `
            MATCH (a:TwinEntity {id: $fromId}), (b:TwinEntity {id: $toId})
            MERGE (a)-[r:${rel.type}]->(b)
            SET r.metadataJson = $metadataJson,
                r.collectedAt = $collectedAt
          `,
          {
            fromId: rel.fromId,
            toId: rel.toId,
            metadataJson: JSON.stringify(rel.metadata ?? {}),
            collectedAt: neo4j.types.DateTime.fromStandardDate(rel.collectedAt),
          }
        );
        created++;
      }
      if (skipped > 0) {
        const { pceLogger } = await import("../../pce/utils/logger");
        pceLogger.warn(`Skipped ${skipped} relationships: invalid or missing entities`);
      }
    } finally {
      await session.close();
    }
  }

  async deleteRelationshipsByType(types: Array<TwinRelationship["type"]>): Promise<void> {
    if (!types.length) return;
    if (!this.initialized) {
      await this.initialize();
    }
    const driver = this.graphStore.getDriver();
    const session = driver.session();
    try {
      await session.run(
        `
          MATCH ()-[r]->()
          WHERE type(r) IN $types
          DELETE r
        `,
        { types }
      );
    } finally {
      await session.close();
    }
  }

  async pruneEntitiesByTypeAndSource(
    type: TwinEntityType,
    source: string,
    keepIds: string[]
  ): Promise<number> {
    if (!this.initialized) {
      await this.initialize();
    }

    const driver = this.graphStore.getDriver();
    const session = driver.session();
    try {
      const result = await session.run(
        `
          MATCH (n:TwinEntity {type: $type})
          WHERE coalesce(n.entitySource, "") = $source
            AND NOT n.id IN $keepIds
          WITH n
          DETACH DELETE n
          RETURN count(n) AS deleted
        `,
        {
          type,
          source,
          keepIds,
        }
      );

      const deleted = result.records[0]?.get("deleted");
      if (typeof deleted?.toNumber === "function") {
        return deleted.toNumber();
      }
      return Number(deleted ?? 0);
    } finally {
      await session.close();
    }
  }

  private buildEntityProperties(entity: TwinEntity): Record<string, any> {
    const data = (entity.data ?? {}) as Record<string, any>;
    const normalizedName = entity.displayName?.toLowerCase?.() ?? null;

    const props: Record<string, any> = {
      dataJson: JSON.stringify(data),
      normalizedName,
      status: null,
      state: null,
      agentAvailable: null,
      nodeId: null,
      nodeName: null,
      normalizedNodeName: null,
      vmId: null,
      primaryIp: null,
      gateway: null,
      cidr: null,
      ips: null,
      action: null,
      direction: null,
      interface: null,
      protocol: null,
      source: null,
      destination: null,
      chain: null,
      ruleType: null,
      vmKind: null,
      aliasName: null,
      aliasType: null,
      aliasEntryCount: null,
      aliasCidrCount: null,
      hostname: null,
      model: null,
      role: null,
      provenance: null,
      managementIps: null,
      declaredTrunkPorts: null,
      declaredVlans: null,
      switchId: null,
      portName: null,
      mode: null,
      accessVlan: null,
      trunkVlans: null,
      portDescription: null,
    };

    if (entity.type === TwinEntityType.COMPUTE_NODE) {
      props.status = data.status ?? null;
      props.nodeName = entity.displayName;
      props.normalizedNodeName = normalizedName;
    }

    if (entity.type === TwinEntityType.COMPUTE_VM) {
      props.state = data.state ?? null;
      if (data.agentAvailable !== undefined) {
        props.agentAvailable = Boolean(data.agentAvailable);
      }
      props.nodeId = data.nodeId ?? null;
      const derivedNodeName =
        typeof data.nodeId === "string" ? data.nodeId.split(":").pop() ?? null : null;
      props.nodeName = derivedNodeName;
      props.normalizedNodeName = derivedNodeName?.toLowerCase() ?? null;
      props.vmKind = data.vmKind ?? null;
    }

    if (entity.type === TwinEntityType.NETWORK_INTERFACE) {
      props.status = data.status ?? null;
      props.nodeName = data.nodeName ?? null;
      props.normalizedNodeName = (data.nodeName || "")
        .toString()
        .toLowerCase();
      props.vmId = data.vmId ?? null;
      props.primaryIp = data.primaryIp ?? null;
      props.ips = Array.isArray(data.ips) ? data.ips : null;
    }

    if (entity.type === TwinEntityType.NETWORK_SUBNET) {
      props.cidr = data.cidr ?? null;
      props.gateway = data.gateway ?? null;
    }

    if (entity.type === TwinEntityType.FIREWALL_RULE) {
      props.action = data.action ?? null;
      props.direction = data.direction ?? null;
      props.interface = data.interface ?? null;
      props.protocol = data.protocol ?? null;
      props.source = data.source ?? null;
      props.destination = data.destination ?? null;
      props.chain = data.chain ?? null;
      props.ruleType = data.ruleType ?? null;
    }

    if (entity.type === TwinEntityType.FIREWALL_ALIAS) {
      props.aliasName = data.name ?? entity.displayName ?? null;
      props.aliasType = data.aliasType ?? null;
      props.aliasEntryCount = Array.isArray(data.entries) ? data.entries.length : null;
      props.aliasCidrCount = Array.isArray(data.cidrs) ? data.cidrs.length : null;
    }

    if (entity.type === TwinEntityType.SWITCH) {
      props.hostname = data.hostname ?? null;
      props.model = data.model ?? null;
      props.role = data.role ?? null;
      props.provenance = data.provenance ?? null;
      props.managementIps = Array.isArray(data.managementIps) ? data.managementIps : null;
      props.declaredTrunkPorts = Array.isArray(data.declaredTrunkPorts) ? data.declaredTrunkPorts : null;
      props.declaredVlans = Array.isArray(data.declaredVlans) ? data.declaredVlans : null;
    }

    if (entity.type === TwinEntityType.SWITCH_PORT) {
      props.switchId = data.switchId ?? null;
      props.portName = data.portName ?? null;
      props.mode = data.mode ?? null;
      props.accessVlan = data.accessVlan ?? null;
      props.trunkVlans = Array.isArray(data.trunkVlans) ? data.trunkVlans : null;
      props.portDescription = data.description ?? null;
      props.provenance = data.provenance ?? null;
    }

    return props;
  }

  async close(): Promise<void> {
    if (this.graphStore) {
      await this.graphStore.close();
    }
  }
}
