/**
 * Knowledge Graph - Neo4j Client
 * Task 5.2: Graph DB Installation & Service Setup
 * Task 5.3: Graph Indexation Module (Write Path)
 */

import neo4j, { type Driver, type Session } from "neo4j-driver";
import type { GraphNode, GraphRelationship, NodeType, RelationshipType } from "../schema/ontology";
import { pceLogger } from "../../utils/logger";

const NEO4J_URI = process.env.NEO4J_URI || "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "password";

export class Neo4jGraphStore {
  private driver: Driver | null = null;
  private uri: string;
  private user: string;
  private password: string;

  constructor(uri: string = NEO4J_URI, user: string = NEO4J_USER, password: string = NEO4J_PASSWORD) {
    this.uri = uri;
    this.user = user;
    this.password = password;
  }

  /**
   * Initialize connection to Neo4j
   */
  async connect(): Promise<void> {
    try {
      this.driver = neo4j.driver(this.uri, neo4j.auth.basic(this.user, this.password));
      await this.driver.verifyConnectivity();
      pceLogger.info("Connected to Neo4j", { uri: this.uri });
    } catch (error: any) {
      pceLogger.error("Failed to connect to Neo4j", { error: error.message });
      throw error;
    }
  }

  /**
   * Get driver instance (for query interface)
   */
  getDriver(): Driver {
    if (!this.driver) {
      throw new Error("Driver not initialized. Call connect() first.");
    }
    return this.driver;
  }

  /**
   * Close connection
   */
  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
      pceLogger.info("Disconnected from Neo4j");
    }
  }

  /**
   * Get a session
   */
  private getSession(): Session {
    if (!this.driver) {
      throw new Error("Neo4j driver not initialized. Call connect() first.");
    }
    return this.driver.session();
  }

  /**
   * Create indexes for better performance
   */
  async createIndexes(): Promise<void> {
    const session = this.getSession();
    try {
      // Index on node ID
      await session.run(`
        CREATE INDEX node_id_index IF NOT EXISTS
        FOR (n:Entity)
        ON (n.id)
      `);

      // Index on node type
      await session.run(`
        CREATE INDEX node_type_index IF NOT EXISTS
        FOR (n:Entity)
        ON (n.type)
      `);

      // Index on version hash for provenance
      await session.run(`
        CREATE INDEX version_hash_index IF NOT EXISTS
        FOR (n:Entity)
        ON (n.versionHash)
      `);

      pceLogger.info("Created Neo4j indexes");
    } catch (error: any) {
      pceLogger.warn("Failed to create indexes (may already exist)", { error: error.message });
    } finally {
      await session.close();
    }
  }

  /**
   * Task 5.3: Write node to graph
   */
  async writeNode(node: GraphNode): Promise<void> {
    const session = this.getSession();
    try {
      // Neo4j doesn't support nested objects - convert attributes to JSON string
      const attributesJson = JSON.stringify(node.attributes);
      
      // Convert Date objects to ISO strings for Neo4j
      const createdAt = node.createdAt instanceof Date 
        ? neo4j.types.DateTime.fromStandardDate(node.createdAt)
        : neo4j.types.DateTime.fromStandardDate(new Date());
      const updatedAt = node.updatedAt instanceof Date
        ? neo4j.types.DateTime.fromStandardDate(node.updatedAt)
        : neo4j.types.DateTime.fromStandardDate(new Date());

      const query = `
        MERGE (n:Entity {id: $id})
        ON CREATE SET n.createdAt = $createdAt,
                     n.type = $type,
                     n.attributes = $attributesJson,
                     n.aliases = $aliases,
                     n.versionHash = $versionHash,
                     n.sourcePath = $sourcePath,
                     n.aclGroup = $aclGroup
        ON MATCH SET n.type = $type,
                     n.attributes = $attributesJson,
                     n.aliases = $aliases,
                     n.versionHash = $versionHash,
                     n.sourcePath = $sourcePath,
                     n.aclGroup = $aclGroup,
                     n.updatedAt = $updatedAt
      `;

      await session.run(query, {
        id: node.id,
        type: node.type,
        attributesJson,
        aliases: node.aliases || [],
        versionHash: node.versionHash || null,
        sourcePath: node.sourcePath || null,
        aclGroup: node.aclGroup || null,
        createdAt,
        updatedAt,
      });

      pceLogger.debug(`Wrote node: ${node.id} (${node.type})`);
    } catch (error: any) {
      pceLogger.error(`Failed to write node: ${node.id}`, { error: error.message });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Task 5.3: Write relationship to graph
   * Task 5.5: Cycle & Duplication Detection
   */
  async writeRelationship(rel: GraphRelationship): Promise<void> {
    // Task 5.5: Prevent self-loops (cycles)
    if (rel.from === rel.to) {
      pceLogger.warn("Skipping self-loop relationship", { from: rel.from, type: rel.type });
      return;
    }

    const session = this.getSession();
    try {
      // Check for duplicate relationship
      const checkQuery = `
        MATCH (a:Entity {id: $from})-[r:${rel.type}]->(b:Entity {id: $to})
        WHERE r.versionHash = $versionHash
        RETURN r
      `;

      const existing = await session.run(checkQuery, {
        from: rel.from,
        to: rel.to,
        versionHash: rel.versionHash || null,
      });

      // Task 5.5: Suppress exact duplicate edge writes
      if (existing.records.length > 0) {
        pceLogger.debug(`Skipping duplicate relationship: ${rel.from} -[${rel.type}]-> ${rel.to}`);
        return;
      }

      // Convert properties to JSON string if it's an object
      const propertiesJson = rel.properties 
        ? JSON.stringify(rel.properties)
        : null;
      
      // Convert Date to Neo4j DateTime
      const createdAt = rel.createdAt instanceof Date
        ? neo4j.types.DateTime.fromStandardDate(rel.createdAt)
        : neo4j.types.DateTime.fromStandardDate(new Date());

      const query = `
        MATCH (a:Entity {id: $from}), (b:Entity {id: $to})
        MERGE (a)-[r:${rel.type}]->(b)
        SET r.properties = $propertiesJson,
            r.versionHash = $versionHash,
            r.sourcePath = $sourcePath,
            r.aclGroup = $aclGroup,
            r.createdAt = $createdAt
      `;

      await session.run(query, {
        from: rel.from,
        to: rel.to,
        propertiesJson,
        versionHash: rel.versionHash || null,
        sourcePath: rel.sourcePath || null,
        aclGroup: rel.aclGroup || null,
        createdAt,
      });

      pceLogger.debug(`Wrote relationship: ${rel.from} -[${rel.type}]-> ${rel.to}`);
    } catch (error: any) {
      pceLogger.error(`Failed to write relationship: ${rel.from} -[${rel.type}]-> ${rel.to}`, {
        error: error.message,
      });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Batch write nodes
   */
  async writeNodes(nodes: GraphNode[]): Promise<void> {
    const session = this.getSession();
    const tx = session.beginTransaction();

    try {
      for (const node of nodes) {
        // Neo4j doesn't support nested objects - convert attributes to JSON string
        const attributesJson = JSON.stringify(node.attributes);
        
        // Convert Date objects to Neo4j DateTime
        const createdAt = node.createdAt instanceof Date 
          ? neo4j.types.DateTime.fromStandardDate(node.createdAt)
          : neo4j.types.DateTime.fromStandardDate(new Date());
        const updatedAt = node.updatedAt instanceof Date
          ? neo4j.types.DateTime.fromStandardDate(node.updatedAt)
          : neo4j.types.DateTime.fromStandardDate(new Date());

        const query = `
          MERGE (n:Entity {id: $id})
          ON CREATE SET n.createdAt = $createdAt,
                       n.type = $type,
                       n.attributes = $attributesJson,
                       n.aliases = $aliases,
                       n.versionHash = $versionHash,
                       n.sourcePath = $sourcePath,
                       n.aclGroup = $aclGroup
          ON MATCH SET n.type = $type,
                       n.attributes = $attributesJson,
                       n.aliases = $aliases,
                       n.versionHash = $versionHash,
                       n.sourcePath = $sourcePath,
                       n.aclGroup = $aclGroup,
                       n.updatedAt = $updatedAt
        `;

        await tx.run(query, {
          id: node.id,
          type: node.type,
          attributesJson,
          aliases: node.aliases || [],
          versionHash: node.versionHash || null,
          sourcePath: node.sourcePath || null,
          aclGroup: node.aclGroup || null,
          createdAt,
          updatedAt,
        });
      }

      await tx.commit();
      pceLogger.info(`Wrote ${nodes.length} nodes in batch`);
    } catch (error: any) {
      await tx.rollback();
      pceLogger.error("Failed to batch write nodes", { error: error.message });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Batch write relationships
   */
  async writeRelationships(relationships: GraphRelationship[]): Promise<void> {
    const session = this.getSession();
    const tx = session.beginTransaction();

    try {
      let written = 0;
      let skipped = 0;

      for (const rel of relationships) {
        // Skip self-loops
        if (rel.from === rel.to) {
          skipped++;
          continue;
        }

        // Check for duplicates
        const checkQuery = `
          MATCH (a:Entity {id: $from})-[r:${rel.type}]->(b:Entity {id: $to})
          WHERE r.versionHash = $versionHash
          RETURN r
        `;

        const existing = await tx.run(checkQuery, {
          from: rel.from,
          to: rel.to,
          versionHash: rel.versionHash || null,
        });

        if (existing.records.length > 0) {
          skipped++;
          continue;
        }

        // Convert properties to JSON string if it's an object
        const propertiesJson = rel.properties 
          ? JSON.stringify(rel.properties)
          : null;
        
        // Convert Date to Neo4j DateTime
        const createdAt = rel.createdAt instanceof Date
          ? neo4j.types.DateTime.fromStandardDate(rel.createdAt)
          : neo4j.types.DateTime.fromStandardDate(new Date());

        const query = `
          MATCH (a:Entity {id: $from}), (b:Entity {id: $to})
          MERGE (a)-[r:${rel.type}]->(b)
          SET r.properties = $propertiesJson,
              r.versionHash = $versionHash,
              r.sourcePath = $sourcePath,
              r.aclGroup = $aclGroup,
              r.createdAt = $createdAt
        `;

        await tx.run(query, {
          from: rel.from,
          to: rel.to,
          propertiesJson,
          versionHash: rel.versionHash || null,
          sourcePath: rel.sourcePath || null,
          aclGroup: rel.aclGroup || null,
          createdAt,
        });

        written++;
      }

      await tx.commit();
      pceLogger.info(`Wrote ${written} relationships, skipped ${skipped} duplicates/cycles`);
    } catch (error: any) {
      await tx.rollback();
      pceLogger.error("Failed to batch write relationships", { error: error.message });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Task 5.4: Wipe all nodes and relationships
   */
  async wipeAll(): Promise<void> {
    const session = this.getSession();
    try {
      await session.run("MATCH (n) DETACH DELETE n");
      pceLogger.warn("Wiped all nodes and relationships from graph");
    } catch (error: any) {
      pceLogger.error("Failed to wipe graph", { error: error.message });
      throw error;
    } finally {
      await session.close();
    }
  }

  /**
   * Task 5.4: Get schema version
   */
  async getSchemaVersion(): Promise<string | null> {
    const session = this.getSession();
    try {
      const result = await session.run(`
        MATCH (n:SchemaVersion)
        RETURN n.version as version
        ORDER BY n.createdAt DESC
        LIMIT 1
      `);

      if (result.records.length > 0) {
        const firstRecord = result.records[0];
        if (firstRecord) {
          return firstRecord.get("version") as string;
        }
      }
      return null;
    } catch (error: any) {
      pceLogger.error("Failed to get schema version", { error: error.message });
      return null;
    } finally {
      await session.close();
    }
  }

  /**
   * Task 5.4: Set schema version
   */
  async setSchemaVersion(version: string): Promise<void> {
    const session = this.getSession();
    try {
      const createdAt = neo4j.types.DateTime.fromStandardDate(new Date());
      await session.run(`
        MERGE (s:SchemaVersion {version: $version})
        SET s.createdAt = $createdAt
      `, { version, createdAt });
      pceLogger.info(`Set schema version: ${version}`);
    } catch (error: any) {
      pceLogger.error("Failed to set schema version", { error: error.message });
      throw error;
    } finally {
      await session.close();
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const session = this.getSession();
      try {
        await session.run("RETURN 1 as ok");
        return true;
      } finally {
        await session.close();
      }
    } catch (error: any) {
      pceLogger.warn("Neo4j health check failed", { error: error.message });
      return false;
    }
  }
}

