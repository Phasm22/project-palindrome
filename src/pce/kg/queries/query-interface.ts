/**
 * Knowledge Graph - Graph Query Interface
 * Task 7.1: Graph Query Interface
 * Task 7.2: Provenance Linkage
 */

import type { Driver } from "neo4j-driver";
import { pceLogger } from "../../utils/logger";
import { DEFAULT_GRAPH_ENTITY_LABEL, toCypherLabel } from "../graph-labels";

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
  private entityLabelCypher: string;

  constructor(
    driver: Driver | { getDriver(): Driver },
    entityLabel: string = DEFAULT_GRAPH_ENTITY_LABEL
  ) {
    // Support both direct driver and Neo4jGraphStore instance
    this.driver = 'getDriver' in driver ? driver.getDriver() : driver;
    this.entityLabelCypher = toCypherLabel(entityLabel);
  }

  /**
   * Task 7.1: Execute Cypher query
   */
  async executeQuery(cypher: string, parameters?: Record<string, any>): Promise<GraphQueryResult> {
    const session = this.driver.session();
    const scopedCypher = cypher.replace(/:Entity\b/g, `:${this.entityLabelCypher}`);
    try {
      pceLogger.debug("Executing Cypher query", { cypher: scopedCypher, parameters });

      const result = await session.run(scopedCypher, parameters || {});

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

            // Parse attributes JSON string back to object (for knowledge graph nodes)
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

            // For TwinEntity nodes, extract meaningful properties directly
            // TwinEntity nodes have properties like: type, displayName, status, state, nodeName, etc.
            const nodeData: any = {
              id: nodeId,
              type: value.labels[0] || "Entity",
              name: value.properties.displayName || value.properties.name || nodeId,
              attributes,
              versionHash: value.properties.versionHash,
              sourcePath: value.properties.sourcePath,
              aclGroup: value.properties.aclGroup,
            };

            // Extract TwinEntity-specific properties if this is a TwinEntity
            if (value.labels.includes('TwinEntity')) {
              // Parse dataJson if it exists
              if (value.properties.dataJson) {
                try {
                  nodeData.data = typeof value.properties.dataJson === 'string'
                    ? JSON.parse(value.properties.dataJson)
                    : value.properties.dataJson;
                } catch {
                  nodeData.data = {};
                }
              }
              
              // Add denormalized properties for easy access
              if (value.properties.type) nodeData.entityType = value.properties.type;
              if (value.properties.displayName) nodeData.displayName = value.properties.displayName;
              if (value.properties.status !== null && value.properties.status !== undefined) nodeData.status = value.properties.status;
              if (value.properties.state !== null && value.properties.state !== undefined) nodeData.state = value.properties.state;
              if (value.properties.nodeName) nodeData.nodeName = value.properties.nodeName;
              if (value.properties.vmKind) nodeData.vmKind = value.properties.vmKind;
              if (value.properties.primaryIp) nodeData.primaryIp = value.properties.primaryIp;
              if (value.properties.cidr) nodeData.cidr = value.properties.cidr;
              if (value.properties.action) nodeData.action = value.properties.action;
              if (value.properties.source) nodeData.source = value.properties.source;
              if (value.properties.destination) nodeData.destination = value.properties.destination;
              if (value.properties.collectedAt) nodeData.collectedAt = value.properties.collectedAt;
              if (value.properties.provenance) nodeData.provenance = value.properties.provenance;
            }

            nodes.set(nodeId, nodeData);
            recordNodes.set(nodeId, nodeData);
          }
          // Check if it's a relationship (direct relationship object)
          // Neo4j Relationship objects have __isRelationship__ marker
          else if (typeof value === "object" && (value.__isRelationship__ || (value.type && value.startNodeElementId))) {
            recordRel = value;
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

          // If we don't have IDs yet, extract from nodes in this record
          // When query is MATCH (n)-[r]->(m) RETURN n, r, m,
          // n and m are the actual node objects with properties.id
          // r.start/r.end are internal Neo4j Integer IDs that match n.identity/m.identity
          if (!fromId || !toId) {
            // Get relationship's start/end element IDs
            const relStartElementId = recordRel.startNodeElementId;
            const relEndElementId = recordRel.endNodeElementId;
            
            // Iterate through all returned values in this record to find matching nodes
            record.keys.forEach((key) => {
              const val = record.get(key);
              if (!val || typeof val !== 'object' || !val.properties?.id) return;
              
              const nodeId = val.properties.id;
              const nodeElementId = val.elementId;
              
              if (!fromId && nodeElementId === relStartElementId) {
                fromId = nodeId;
              }
              if (!toId && nodeElementId === relEndElementId) {
                toId = nodeId;
              }
            });
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
      pceLogger.error("Failed to execute Cypher query", {
        error: error.message,
        cypher: scopedCypher,
      });
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
      MATCH (alert:${this.entityLabelCypher} {type: 'Alert'})-[r:AFFECTS]->(host:${this.entityLabelCypher} {id: $hostId})
      RETURN alert, r, host, startNode(r).id as fromId, endNode(r).id as toId
    `;
    return this.executeQuery(cypher, { hostId });
  }

  /**
   * Find all hosts connected to a service
   */
  async findHostsConnectedToService(serviceId: string): Promise<GraphQueryResult> {
    const cypher = `
      MATCH (host:${this.entityLabelCypher} {type: 'Host'})-[r:CONNECTS_TO]->(service:${this.entityLabelCypher} {id: $serviceId})
      RETURN host, r, service, host.id as hostId, service.id as serviceId, startNode(r).id as fromId, endNode(r).id as toId
    `;
    return this.executeQuery(cypher, { serviceId });
  }

  /**
   * Find path between two entities
   */
  async findPath(fromId: string, toId: string, maxDepth: number = 5): Promise<GraphQueryResult> {
    const cypher = `
      MATCH path = shortestPath((from:${this.entityLabelCypher} {id: $fromId})-[*1..${maxDepth}]-(to:${this.entityLabelCypher} {id: $toId}))
      RETURN path
    `;
    return this.executeQuery(cypher, { fromId, toId });
  }

  /**
   * Get all entities of a specific type
   */
  async getEntitiesByType(type: string): Promise<GraphQueryResult> {
    const cypher = `
      MATCH (n:${this.entityLabelCypher} {type: $type})
      RETURN n
    `;
    return this.executeQuery(cypher, { type });
  }

  /**
   * Find entities by ID or name (case-insensitive partial match)
   */
  async findEntitiesByIdOrName(searchTerm: string): Promise<GraphQueryResult> {
    const cypher = `
      MATCH (n:${this.entityLabelCypher})
      WHERE n.id =~ $pattern OR 
            ANY(alias IN n.aliases WHERE alias =~ $pattern) OR
            (n.attributes IS NOT NULL AND n.attributes CONTAINS $searchTerm)
      RETURN n
      LIMIT 50
    `;
    // Case-insensitive pattern: (?i) for case-insensitive, .* for wildcard
    const pattern = `(?i).*${searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*`;
    return this.executeQuery(cypher, { pattern, searchTerm });
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
        MATCH (n:${this.entityLabelCypher})
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

  /**
   * Phase I-B: Find all entities that depend on a given entity
   */
  async findDependents(entityId: string): Promise<GraphQueryResult> {
    const cypher = `
      MATCH (dependent:${this.entityLabelCypher})-[r:DEPENDS_ON]->(target:${this.entityLabelCypher} {id: $entityId})
      RETURN dependent, r, target, startNode(r).id as fromId, endNode(r).id as toId
    `;
    return this.executeQuery(cypher, { entityId });
  }

  /**
   * Phase I-B: Find all dependencies of a given entity
   */
  async findDependencies(entityId: string): Promise<GraphQueryResult> {
    const cypher = `
      MATCH (entity:${this.entityLabelCypher} {id: $entityId})-[r:DEPENDS_ON]->(dependency:${this.entityLabelCypher})
      RETURN entity, r, dependency, startNode(r).id as fromId, endNode(r).id as toId
    `;
    return this.executeQuery(cypher, { entityId });
  }

  /**
   * Phase I-B: Find all entities hosted by a given host
   */
  async findHostedEntities(hostId: string): Promise<GraphQueryResult> {
    const cypher = `
      MATCH (host:${this.entityLabelCypher} {id: $hostId})-[r:HOSTS]->(entity:${this.entityLabelCypher})
      RETURN host, r, entity, startNode(r).id as fromId, endNode(r).id as toId
    `;
    return this.executeQuery(cypher, { hostId });
  }

  /**
   * Phase I-B: Find dependency chain (what breaks if entity goes down)
   */

  /**
   * TL-3.0: Find entities by purpose/role
   * Query hosts, services, and containers by their role or purpose
   * Handles attributes stored as JSON string
   */
  async findByPurpose(purpose: string): Promise<GraphQueryResult> {
    const cypher = `
      MATCH (n:${this.entityLabelCypher})
      WHERE (n.type = "Host" OR n.type = "Service" OR n.type = "Container")
        AND toLower(toString(n.attributes)) CONTAINS toLower($purpose)
      RETURN n
      LIMIT 100
    `;
    return this.executeQuery(cypher, { purpose });
  }

  /**
   * TL-3.0: Find entities by architecture
   * Query entities by network architecture, system architecture, or deployment architecture
   */
  async findByArchitecture(architecture: string): Promise<GraphQueryResult> {
    const cypher = `
      MATCH (n:${this.entityLabelCypher})
      WHERE toString(n.attributes) CONTAINS $architecture
      RETURN n
      LIMIT 100
    `;
    return this.executeQuery(cypher, { architecture });
  }

  /**
   * TL-3.0: Find all entities with a specific role
   * More specific than findByPurpose - exact role match
   */
  async findByRole(role: string): Promise<GraphQueryResult> {
    const cypher = `
      MATCH (n:${this.entityLabelCypher})
      WHERE (n.type = "Host" OR n.type = "Service" OR n.type = "Container")
        AND toString(n.attributes) CONTAINS $role
      RETURN n
      LIMIT 100
    `;
    return this.executeQuery(cypher, { role });
  }

  /**
   * TL-3.0: Find entities by purpose with relationships
   * Returns entities and their connections for architecture analysis
   */
  async findByPurposeWithRelationships(purpose: string): Promise<GraphQueryResult> {
    const cypher = `
      MATCH (n:${this.entityLabelCypher})
      WHERE (n.type = "Host" OR n.type = "Service" OR n.type = "Container")
        AND toString(n.attributes) CONTAINS $purpose
      OPTIONAL MATCH (n)-[r]-(connected:${this.entityLabelCypher})
      RETURN n, r, connected
      LIMIT 100
    `;
    return this.executeQuery(cypher, { purpose });
  }
  async findDependencyChain(entityId: string, maxDepth: number = 10): Promise<GraphQueryResult> {
    const cypher = `
      MATCH path = (entity:${this.entityLabelCypher} {id: $entityId})<-[:DEPENDS_ON*1..${maxDepth}]-(dependent:${this.entityLabelCypher})
      RETURN path
      ORDER BY length(path) DESC
      LIMIT 100
    `;
    return this.executeQuery(cypher, { entityId });
  }
}
