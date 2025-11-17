/**
 * Knowledge Graph - Graph Query Interface
 * Task 7.1: Graph Query Interface
 * Task 7.2: Provenance Linkage
 */

import type { Driver } from "neo4j-driver";
import { pceLogger } from "../../utils/logger";

export interface GraphQueryResult {
  nodes: Array<{
    id: string;
    type: string;
    attributes: Record<string, any>;
    versionHash?: string;
    sourcePath?: string;
    aclGroup?: string;
  }>;
  relationships: Array<{
    from: string;
    to: string;
    type: string;
    properties?: Record<string, any>;
    versionHash?: string;
    sourcePath?: string;
    aclGroup?: string;
  }>;
  paths?: Array<{
    nodes: string[];
    relationships: string[];
  }>;
}

export class GraphQueryInterface {
  private driver: Driver;

  constructor(driver: Driver | { getDriver(): Driver }) {
    // Support both direct driver and Neo4jGraphStore instance
    this.driver = 'getDriver' in driver ? driver.getDriver() : driver;
  }

  /**
   * Task 7.1: Execute Cypher query
   */
  async executeQuery(cypher: string, parameters?: Record<string, any>): Promise<GraphQueryResult> {
    const session = this.driver.session();
    try {
      pceLogger.debug("Executing Cypher query", { cypher, parameters });

      const result = await session.run(cypher, parameters || {});

      const nodes = new Map<string, any>();
      const relationships: any[] = [];
      const paths: any[] = [];

      for (const record of result.records) {
        // Track nodes and relationships found in this record
        const recordNodes: Map<string, any> = new Map();
        let recordRel: any = null;

        // First pass: identify all nodes and relationships
        record.keys.forEach((key) => {
          const value = record.get(key);
          if (!value) return;

          // Check if it's a node
          if (typeof value === "object" && value.labels && Array.isArray(value.labels) && value.properties) {
            const nodeId = value.properties.id || (value.identity ? value.identity.toString() : null);
            if (!nodeId) return;

            // Parse attributes JSON string back to object
            let attributes = {};
            if (value.properties.attributes) {
              try {
                attributes = typeof value.properties.attributes === 'string'
                  ? JSON.parse(value.properties.attributes)
                  : value.properties.attributes;
              } catch {
                attributes = {};
              }
            }

            const nodeData = {
              id: nodeId,
              type: value.labels[0] || "Entity",
              attributes,
              versionHash: value.properties.versionHash,
              sourcePath: value.properties.sourcePath,
              aclGroup: value.properties.aclGroup,
            };

            nodes.set(nodeId, nodeData);
            recordNodes.set(nodeId, nodeData);
          }
          // Check if it's a relationship (direct relationship object)
          else if (typeof value === "object" && value.type) {
            // Relationship object - check if it has start/end
            if (value.start && value.end) {
              recordRel = value;
            } else {
              // Relationship might be returned without start/end - store it anyway
              recordRel = value;
            }
          }
          // Check if it's a path
          else if (Array.isArray(value)) {
            const pathNodes: string[] = [];
            const pathRels: string[] = [];
            value.forEach((segment: any) => {
              if (segment.start) {
                const id = segment.start.properties?.id || (segment.start.identity ? segment.start.identity.toString() : null);
                if (id) pathNodes.push(id);
              }
              if (segment.relationship) {
                pathRels.push(segment.relationship.type);
              }
              if (segment.end) {
                const id = segment.end.properties?.id || (segment.end.identity ? segment.end.identity.toString() : null);
                if (id) pathNodes.push(id);
              }
            });
            if (pathNodes.length > 0) {
              paths.push({ nodes: pathNodes, relationships: pathRels });
            }
          }
        });

        // Second pass: extract relationship info if we found one
        if (recordRel && recordRel.type) {
          let fromId: string | null = null;
          let toId: string | null = null;

          // First, try to get IDs from explicit query results (fromId, toId)
          record.keys.forEach((key) => {
            if (key === 'fromId' || key === 'hostId') {
              const val = record.get(key);
              if (val && !fromId) fromId = String(val);
            }
            if (key === 'toId' || key === 'serviceId') {
              const val = record.get(key);
              if (val && !toId) toId = String(val);
            }
          });

          // If we don't have IDs from query, try to get from relationship object
          if ((!fromId || !toId) && recordRel.start && recordRel.end) {
            const startNode = recordRel.start;
            const endNode = recordRel.end;

            // Extract from node ID - try multiple ways
            if (!fromId && startNode) {
              if (typeof startNode === 'object') {
                if (startNode.properties?.id) {
                  fromId = startNode.properties.id;
                } else if (startNode.identity !== undefined && startNode.identity !== null) {
                  fromId = String(startNode.identity);
                }
              } else if (typeof startNode === 'string') {
                fromId = startNode;
              } else if (typeof startNode === 'number') {
                fromId = String(startNode);
              }
            }

            // Extract to node ID - try multiple ways
            if (!toId && endNode) {
              if (typeof endNode === 'object') {
                if (endNode.properties?.id) {
                  toId = endNode.properties.id;
                } else if (endNode.identity !== undefined && endNode.identity !== null) {
                  toId = String(endNode.identity);
                }
              } else if (typeof endNode === 'string') {
                toId = endNode;
              } else if (typeof endNode === 'number') {
                toId = String(endNode);
              }
            }
          }

          if (fromId && toId) {
            // Parse properties JSON string back to object
            let properties = {};
            if (recordRel.properties) {
              try {
                const props = recordRel.properties.properties || recordRel.properties;
                properties = typeof props === 'string'
                  ? JSON.parse(props)
                  : (props || {});
              } catch {
                properties = {};
              }
            }

            relationships.push({
              from: fromId,
              to: toId,
              type: recordRel.type,
              properties,
              versionHash: recordRel.properties?.versionHash,
              sourcePath: recordRel.properties?.sourcePath,
              aclGroup: recordRel.properties?.aclGroup,
            });
          }
        }
      }

      pceLogger.debug(`Query returned ${nodes.size} nodes, ${relationships.length} relationships`);

      return {
        nodes: Array.from(nodes.values()),
        relationships,
        paths: paths.length > 0 ? paths : undefined,
      };
    } catch (error: any) {
      pceLogger.error("Failed to execute Cypher query", { error: error.message, cypher });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Find all alerts affecting a host
   */
  async findAlertsAffectingHost(hostId: string): Promise<GraphQueryResult> {
    const cypher = `
      MATCH (alert:Entity {type: 'Alert'})-[r:AFFECTS]->(host:Entity {id: $hostId})
      RETURN alert, r, host, startNode(r).id as fromId, endNode(r).id as toId
    `;
    return this.executeQuery(cypher, { hostId });
  }

  /**
   * Find all hosts connected to a service
   */
  async findHostsConnectedToService(serviceId: string): Promise<GraphQueryResult> {
    const cypher = `
      MATCH (host:Entity {type: 'Host'})-[r:CONNECTS_TO]->(service:Entity {id: $serviceId})
      RETURN host, r, service, host.id as hostId, service.id as serviceId, startNode(r).id as fromId, endNode(r).id as toId
    `;
    return this.executeQuery(cypher, { serviceId });
  }

  /**
   * Find path between two entities
   */
  async findPath(fromId: string, toId: string, maxDepth: number = 5): Promise<GraphQueryResult> {
    const cypher = `
      MATCH path = shortestPath((from:Entity {id: $fromId})-[*1..${maxDepth}]-(to:Entity {id: $toId}))
      RETURN path
    `;
    return this.executeQuery(cypher, { fromId, toId });
  }

  /**
   * Get all entities of a specific type
   */
  async getEntitiesByType(type: string): Promise<GraphQueryResult> {
    const cypher = `
      MATCH (n:Entity {type: $type})
      RETURN n
    `;
    return this.executeQuery(cypher, { type });
  }

  /**
   * Task 7.2: Get entities with provenance (version hash and source path)
   */
  async getEntitiesWithProvenance(entityIds: string[]): Promise<Array<{
    id: string;
    versionHash?: string;
    sourcePath?: string;
  }>> {
    const session = this.driver.session();
    try {
      const cypher = `
        MATCH (n:Entity)
        WHERE n.id IN $entityIds
        RETURN n.id as id, n.versionHash as versionHash, n.sourcePath as sourcePath
      `;
      const result = await session.run(cypher, { entityIds });
      
      return result.records.map((record: any) => ({
        id: record.get("id"),
        versionHash: record.get("versionHash"),
        sourcePath: record.get("sourcePath"),
      }));
    } catch (error: any) {
      pceLogger.error("Failed to get entities with provenance", { error: error.message });
      throw error;
    } finally {
      await session.close();
    }
  }
}

