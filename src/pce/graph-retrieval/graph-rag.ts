/**
 * Graph Retrieval & Orchestration (V2)
 * Task 7.3: Graph-Only Retrieval Path
 */

import type { GraphQueryInterface, GraphQueryResult } from "../kg/queries/query-interface";
import type { ACLGroup } from "../types";
import { pceLogger } from "../utils/logger";

export interface GraphRetrievalResult {
  entities: Array<{
    id: string;
    type: string;
    attributes: Record<string, any>;
    versionHash?: string;
    sourcePath?: string;
    aclGroup?: ACLGroup;
  }>;
  relationships: Array<{
    from: string;
    to: string;
    type: string;
    versionHash?: string;
    sourcePath?: string;
    aclGroup?: ACLGroup;
  }>;
  paths?: Array<{
    nodes: string[];
    relationships: string[];
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
  async retrieve(
    query: string,
    queryType: "alerts" | "connections" | "path" | "entities" = "entities",
    aclGroup?: ACLGroup
  ): Promise<GraphRetrievalResult> {
    try {
      pceLogger.info("Graph-only retrieval", { query, queryType });

      let result: GraphQueryResult;

      if (queryType === "alerts" && query.includes("alert")) {
        const hostId = query.match(/(?:host|server)\s+([a-z0-9-]+)/i)?.[1];
        if (hostId) {
          result = await this.queryInterface.findAlertsAffectingHost(hostId);
        } else {
          result = await this.queryInterface.getEntitiesByType("Alert");
        }
      } else if (queryType === "connections" && query.includes("connect")) {
        const serviceId = query.match(/(?:service|port)\s+([a-z0-9-]+)/i)?.[1];
        if (serviceId) {
          result = await this.queryInterface.findHostsConnectedToService(serviceId);
        } else {
          result = { nodes: [], relationships: [] };
        }
      } else if (queryType === "path") {
        const pathMatch = query.match(/(?:from|between)\s+([a-z0-9-]+)\s+(?:to|and)\s+([a-z0-9-]+)/i);
        const fromId = pathMatch?.[1];
        const toId = pathMatch?.[2];
        if (fromId && toId) {
          result = await this.queryInterface.findPath(fromId, toId);
        } else {
          result = { nodes: [], relationships: [] };
        }
      } else {
        // Try to find entities by ID or name first
        // Extract potential entity identifiers from query
        const entityMatch = query.match(/(?:is|are|find|show|where|what)\s+([a-zA-Z0-9_-]+)/i);
        if (entityMatch && entityMatch[1]) {
          const searchTerm = entityMatch[1];
          result = await this.queryInterface.findEntitiesByIdOrName(searchTerm);
        }
        
        // If no results, try searching for Proxmox entities
        if (!result || result.nodes.length === 0) {
          // Try Proxmox node types
          const proxmoxResult = await this.queryInterface.getEntitiesByType("PVE_NODE");
          if (proxmoxResult.nodes.length > 0) {
            result = proxmoxResult;
          } else {
            // Try VM instances
            const vmResult = await this.queryInterface.getEntitiesByType("VM_INSTANCE");
            if (vmResult.nodes.length > 0) {
              result = vmResult;
            } else {
              // Fallback to Host type
        result = await this.queryInterface.getEntitiesByType("Host");
            }
          }
        }
      }

      const entityIds = result.nodes.map((n) => n.id);
      await this.queryInterface.getEntitiesWithProvenance(entityIds);

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

      return this.enforceAclGuards(
        {
          entities: result.nodes,
          relationships: result.relationships,
          paths: result.paths,
          provenance: Array.from(provenanceMap.values()),
        },
        aclGroup
      );
    } catch (error: any) {
      pceLogger.error("Graph retrieval failed", { error: error.message });
      throw error;
    }
  }

  /**
   * Custom Cypher query retrieval
   */
  async retrieveWithCypher(
    cypher: string,
    parameters?: Record<string, any>,
    aclGroup?: ACLGroup
  ): Promise<GraphRetrievalResult> {
    const result = await this.queryInterface.executeQuery(cypher, parameters);

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

    return this.enforceAclGuards(
      {
        entities: result.nodes,
        relationships: result.relationships,
        paths: result.paths,
        provenance: Array.from(provenanceMap.values()),
      },
      aclGroup
    );
  }

  private enforceAclGuards(result: GraphRetrievalResult, aclGroup?: ACLGroup): GraphRetrievalResult {
    if (!aclGroup || aclGroup === "admin") {
      return result;
    }

    const entities = result.entities.filter((entity) => this.isAclAllowed(entity.aclGroup, aclGroup));
    const allowedIds = new Set(entities.map((entity) => entity.id));
    const relationships = result.relationships.filter(
      (rel) =>
        this.isAclAllowed(rel.aclGroup, aclGroup) &&
        allowedIds.has(rel.from) &&
        allowedIds.has(rel.to)
    );

    const paths = (result.paths ?? []).filter((path) => path.nodes.every((nodeId) => allowedIds.has(nodeId)));

    const provenanceIds = new Set([
      ...entities.map((entity) => entity.versionHash).filter(Boolean),
      ...relationships.map((rel) => rel.versionHash).filter(Boolean),
    ]);

    const provenance = result.provenance.filter((prov) => provenanceIds.has(prov.versionHash));

    if (entities.length !== result.entities.length || relationships.length !== result.relationships.length) {
      pceLogger.warn("Graph ACL pruning removed restricted entities", {
        requestedAcl: aclGroup,
        originalEntities: result.entities.length,
        filteredEntities: entities.length,
      });
    }

    return {
      entities,
      relationships,
      paths,
      provenance,
    };
  }

  private isAclAllowed(resourceAcl: ACLGroup | undefined, requester: ACLGroup): boolean {
    if (!resourceAcl) {
      return true;
    }
    if (requester === "admin") {
      return true;
    }
    return resourceAcl === requester;
  }
}

