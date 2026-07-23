/**
 * Knowledge Graph - Graph Indexer
 * Orchestrates EDL pipeline and graph writing
 */

import type { DocumentChunk } from "../../types";
import { EDLPipeline } from "../../edl/pipeline";
import { Neo4jGraphStore } from "./neo4j-client";
import { CURRENT_ONTOLOGY_VERSION, NodeType } from "../schema/ontology";
import { pceLogger } from "../../utils/logger";

export interface GraphIndexationResult {
  nodesWritten: number;
  relationshipsWritten: number;
  stats: {
    entitiesExtracted: number;
    entitiesValidated: number;
    entitiesNormalized: number;
    aliasesResolved: number;
    relationshipsExtracted: number;
  };
}

export interface ProxmoxVmSnapshot {
  nodeName: string;
  keepIds: string[];
}

export interface StoredProxmoxVmEntity {
  id: string;
  attributes: string | Record<string, unknown> | null;
  sourcePath: string | null;
}

function parseStoredAttributes(
  attributes: StoredProxmoxVmEntity["attributes"]
): Record<string, unknown> | null {
  if (attributes && typeof attributes === "object") {
    return attributes;
  }
  if (typeof attributes !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(attributes);
    return parsed && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function selectStaleProxmoxVmEntityIds(
  storedEntities: StoredProxmoxVmEntity[],
  snapshots: ProxmoxVmSnapshot[]
): string[] {
  const keepIdsByNode = new Map<string, Set<string>>();
  for (const snapshot of snapshots) {
    const nodeName = snapshot.nodeName.trim().toLowerCase();
    if (!nodeName) continue;
    const keepIds = keepIdsByNode.get(nodeName) || new Set<string>();
    for (const id of snapshot.keepIds) keepIds.add(id);
    keepIdsByNode.set(nodeName, keepIds);
  }

  return storedEntities
    .filter((entity) => entity.sourcePath?.startsWith("proxmox://"))
    .filter((entity) => {
      const attributes = parseStoredAttributes(entity.attributes);
      const nodeName =
        typeof attributes?.node === "string"
          ? attributes.node.trim().toLowerCase()
          : "";
      const keepIds = keepIdsByNode.get(nodeName);
      return keepIds ? !keepIds.has(entity.id) : false;
    })
    .map((entity) => entity.id)
    .sort();
}

export async function pruneStaleProxmoxVmEntities(
  graphStore: Neo4jGraphStore,
  snapshots: ProxmoxVmSnapshot[]
): Promise<string[]> {
  if (snapshots.length === 0) return [];

  const session = graphStore.getDriver().session();
  try {
    const storedResult = await session.run(
      `
        MATCH (n:Entity {type: $type})
        RETURN n.id AS id, n.attributes AS attributes, n.sourcePath AS sourcePath
      `,
      { type: NodeType.VM_INSTANCE }
    );
    const storedEntities = storedResult.records.map((record) => ({
      id: record.get("id") as string,
      attributes: record.get("attributes") as StoredProxmoxVmEntity["attributes"],
      sourcePath: record.get("sourcePath") as string | null,
    }));
    const staleIds = selectStaleProxmoxVmEntityIds(storedEntities, snapshots);
    if (staleIds.length === 0) return [];

    await session.run(
      `
        MATCH (n:Entity {type: $type})
        WHERE n.id IN $staleIds
        DETACH DELETE n
      `,
      {
        type: NodeType.VM_INSTANCE,
        staleIds,
      }
    );
    return staleIds;
  } finally {
    await session.close();
  }
}

/**
 * Graph Indexer - Complete pipeline from chunks to graph
 */
export class GraphIndexer {
  private graphStore: Neo4jGraphStore;
  private edlPipeline: EDLPipeline;

  constructor(graphStore: Neo4jGraphStore, edlPipeline?: EDLPipeline) {
    this.graphStore = graphStore;
    this.edlPipeline = edlPipeline || new EDLPipeline();
  }

  /**
   * Index chunks into graph
   */
  async indexChunks(chunks: DocumentChunk[]): Promise<GraphIndexationResult> {
    try {
      pceLogger.info(`Starting graph indexation for ${chunks.length} chunks`);

      // Step 1: Process through EDL pipeline
      const edlResult = await this.edlPipeline.processChunks(chunks);

      // Step 2: Write nodes to graph
      await this.graphStore.writeNodes(edlResult.nodes);

      // Step 3: Write relationships to graph
      await this.graphStore.writeRelationships(edlResult.relationships);

      // Step 4: Set schema version
      await this.graphStore.setSchemaVersion(CURRENT_ONTOLOGY_VERSION);

      pceLogger.info("Graph indexation complete", {
        nodes: edlResult.nodes.length,
        relationships: edlResult.relationships.length,
      });

      return {
        nodesWritten: edlResult.nodes.length,
        relationshipsWritten: edlResult.relationships.length,
        stats: edlResult.stats,
      };
    } catch (error: any) {
      pceLogger.error("Graph indexation failed", { error: error.message });
      throw error;
    }
  }

  /**
   * Wipe graph and re-index
   */
  async wipeAndReindex(chunks: DocumentChunk[]): Promise<GraphIndexationResult> {
    pceLogger.warn("Wiping graph before re-indexation");
    await this.graphStore.wipeAll();
    return this.indexChunks(chunks);
  }
}
