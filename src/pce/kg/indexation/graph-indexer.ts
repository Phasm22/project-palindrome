/**
 * Knowledge Graph - Graph Indexer
 * Orchestrates EDL pipeline and graph writing
 */

import type { DocumentChunk } from "../../types";
import { EDLPipeline } from "../../edl/pipeline";
import { Neo4jGraphStore } from "./neo4j-client";
import { CURRENT_ONTOLOGY_VERSION } from "../schema/ontology";
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

