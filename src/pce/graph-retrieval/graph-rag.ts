/**
 * Graph Retrieval & Orchestration (V2)
 * Task 7.3: Graph-Only Retrieval Path
 */

import type { GraphQueryInterface, GraphQueryResult } from "../kg/queries/query-interface";
import { pceLogger } from "../utils/logger";

export interface GraphRetrievalResult {
  entities: Array<{
    id: string;
    type: string;
    attributes: Record<string, any>;
    versionHash?: string;
    sourcePath?: string;
  }>;
  relationships: Array<{
    from: string;
    to: string;
    type: string;
    versionHash?: string;
    sourcePath?: string;
  }>;
  provenance: Array<{
    versionHash: string;
    sourcePath: string;
  }>;
}

/**
 * Graph-Only RAG Retrieval
 * User Query -> Graph Query -> Retrieve related document hashes/IDs -> Return results
 */
export class GraphRAGRetrieval {
  private queryInterface: GraphQueryInterface;

  constructor(queryInterface: GraphQueryInterface) {
    this.queryInterface = queryInterface;
  }

  /**
   * Task 7.3: Graph-only retrieval path
   * Query the graph and return entities with provenance
   */
  async retrieve(query: string, queryType: "alerts" | "connections" | "path" | "entities" = "entities"): Promise<GraphRetrievalResult> {
    try {
      pceLogger.info("Graph-only retrieval", { query, queryType });

      let result: GraphQueryResult;

      // Simple query routing based on query type
      // In production, this would use NLP to determine query intent
      if (queryType === "alerts" && query.includes("alert")) {
        // Extract host ID from query (simplified)
        const hostMatch = query.match(/(?:host|server)\s+([a-z0-9-]+)/i);
        if (hostMatch) {
          result = await this.queryInterface.findAlertsAffectingHost(hostMatch[1]);
        } else {
          result = await this.queryInterface.getEntitiesByType("Alert");
        }
      } else if (queryType === "connections" && query.includes("connect")) {
        // Extract service ID from query (simplified)
        const serviceMatch = query.match(/(?:service|port)\s+([a-z0-9-]+)/i);
        if (serviceMatch) {
          result = await this.queryInterface.findHostsConnectedToService(serviceMatch[1]);
        } else {
          result = { nodes: [], relationships: [] };
        }
      } else if (queryType === "path") {
        // Extract from/to IDs from query (simplified)
        const pathMatch = query.match(/(?:from|between)\s+([a-z0-9-]+)\s+(?:to|and)\s+([a-z0-9-]+)/i);
        if (pathMatch) {
          result = await this.queryInterface.findPath(pathMatch[1], pathMatch[2]);
        } else {
          result = { nodes: [], relationships: [] };
        }
      } else {
        // Default: get all entities
        result = await this.queryInterface.getEntitiesByType("Host");
      }

      // Task 7.2: Extract provenance (version hash + source path)
      const entityIds = result.nodes.map((n) => n.id);
      const provenanceData = await this.queryInterface.getEntitiesWithProvenance(entityIds);

      // Build unique provenance list
      const provenanceMap = new Map<string, { versionHash: string; sourcePath: string }>();
      for (const node of result.nodes) {
        if (node.versionHash && node.sourcePath) {
          provenanceMap.set(node.versionHash, {
            versionHash: node.versionHash,
            sourcePath: node.sourcePath,
          });
        }
      }
      for (const rel of result.relationships) {
        if (rel.versionHash && rel.sourcePath) {
          provenanceMap.set(rel.versionHash, {
            versionHash: rel.versionHash,
            sourcePath: rel.sourcePath,
          });
        }
      }

      pceLogger.info("Graph retrieval complete", {
        entities: result.nodes.length,
        relationships: result.relationships.length,
        provenance: provenanceMap.size,
      });

      return {
        entities: result.nodes,
        relationships: result.relationships,
        provenance: Array.from(provenanceMap.values()),
      };
    } catch (error: any) {
      pceLogger.error("Graph retrieval failed", { error: error.message });
      throw error;
    }
  }

  /**
   * Custom Cypher query retrieval
   */
  async retrieveWithCypher(cypher: string, parameters?: Record<string, any>): Promise<GraphRetrievalResult> {
    const result = await this.queryInterface.executeQuery(cypher, parameters);

    // Extract provenance
    const provenanceMap = new Map<string, { versionHash: string; sourcePath: string }>();
    for (const node of result.nodes) {
      if (node.versionHash && node.sourcePath) {
        provenanceMap.set(node.versionHash, {
          versionHash: node.versionHash,
          sourcePath: node.sourcePath,
        });
      }
    }

    return {
      entities: result.nodes,
      relationships: result.relationships,
      provenance: Array.from(provenanceMap.values()),
    };
  }
}

