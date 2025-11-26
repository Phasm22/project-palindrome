import neo4j from "neo4j-driver";
import { Neo4jGraphStore } from "../../pce/kg/indexation/neo4j-client";
import type { TwinEntity } from "../models/entities";
import { TwinEntityType } from "../models/entities";
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
                n.source = $source,
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
                n.primaryIp = $primaryIp,
                n.gateway = $gateway,
                n.cidr = $cidr,
                n.ips = $ips
          `,
          {
            id: entity.id,
            type: entity.type,
            displayName: entity.displayName,
            source: entity.source ?? null,
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
    try {
      for (const rel of relationships) {
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
      }
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

    return props;
  }
}

