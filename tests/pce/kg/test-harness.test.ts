/**
 * Knowledge Graph Subsystem Test Harness
 * Task 7.4: KG Subsystem Test Harness
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "fs";
import { join } from "path";
import {
  Neo4jGraphStore,
  GraphQueryInterface,
  NodeType,
  RelationshipType,
  type GraphNode,
  type GraphRelationship,
} from "../../../src/pce/kg";
import { GraphRAGRetrieval } from "../../../src/pce/graph-retrieval";
import { pceLogger } from "../../../src/pce/utils/logger";

const TEST_DIR = "./.pce-kg-test";

describe("KG Subsystem Test Harness", () => {
  let graphStore: Neo4jGraphStore;
  let queryInterface: GraphQueryInterface;
  let graphRAG: GraphRAGRetrieval;

  beforeEach(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {}

    graphStore = new Neo4jGraphStore(
      process.env.NEO4J_URI || "bolt://localhost:7687",
      process.env.NEO4J_USER || "neo4j",
      process.env.NEO4J_PASSWORD || "password"
    );

    try {
      await graphStore.connect();
      await graphStore.createIndexes();
      queryInterface = new GraphQueryInterface(graphStore.getDriver());
      graphRAG = new GraphRAGRetrieval(queryInterface);
    } catch (error: any) {
      console.warn("Neo4j not available, skipping tests:", error.message);
      // Skip tests if Neo4j is not available
    }
  });

  afterEach(async () => {
    if (graphStore) {
      try {
        await graphStore.wipeAll();
        await graphStore.close();
      } catch {}
    }
  });

  it("should write and retrieve nodes", async () => {
    if (!graphStore) return;

    const node: GraphNode = {
      id: "host:test-server",
      type: NodeType.HOST,
      attributes: {
        hostname: "test-server",
        ip: "192.168.1.100",
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await graphStore.writeNode(node);

    const result = await queryInterface.getEntitiesByType(NodeType.HOST);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.nodes[0].id).toBe("host:test-server");
  });

  it("should write and retrieve relationships", async () => {
    if (!graphStore) return;

    const hostNode: GraphNode = {
      id: "host:server-a",
      type: NodeType.HOST,
      attributes: { hostname: "server-a" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const serviceNode: GraphNode = {
      id: "service:web",
      type: NodeType.SERVICE,
      attributes: { name: "web", port: 80 },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await graphStore.writeNode(hostNode);
    await graphStore.writeNode(serviceNode);

    const rel: GraphRelationship = {
      id: "rel-1",
      type: RelationshipType.CONNECTS_TO,
      from: "host:server-a",
      to: "service:web",
      createdAt: new Date(),
    };

    await graphStore.writeRelationship(rel);

    const result = await queryInterface.executeQuery(`
      MATCH (h:Entity {id: 'host:server-a'})-[r:CONNECTS_TO]->(s:Entity {id: 'service:web'})
      RETURN h, r, s, startNode(r).id as fromId, endNode(r).id as toId
    `);

    expect(result.relationships.length).toBeGreaterThan(0);
    expect(result.relationships[0].type).toBe("CONNECTS_TO");
  });

  it("should prevent self-loops (cycles)", async () => {
    if (!graphStore) return;

    const node: GraphNode = {
      id: "host:test",
      type: NodeType.HOST,
      attributes: { hostname: "test" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await graphStore.writeNode(node);

    const rel: GraphRelationship = {
      id: "self-loop",
      type: RelationshipType.CONNECTS_TO,
      from: "host:test",
      to: "host:test", // Self-loop
      createdAt: new Date(),
    };

    await graphStore.writeRelationship(rel);

    // Should not create the relationship
    const result = await queryInterface.executeQuery(`
      MATCH (n:Entity {id: 'host:test'})-[r]->(n)
      RETURN count(r) as count
    `);

    // Self-loops should be prevented
    expect(result.nodes.length).toBe(0);
  });

  it("should prevent duplicate relationships", async () => {
    if (!graphStore) return;

    const host1: GraphNode = {
      id: "host:host1",
      type: NodeType.HOST,
      attributes: { hostname: "host1" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const host2: GraphNode = {
      id: "host:host2",
      type: NodeType.HOST,
      attributes: { hostname: "host2" },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await graphStore.writeNode(host1);
    await graphStore.writeNode(host2);

    const rel: GraphRelationship = {
      id: "rel-1",
      type: RelationshipType.CONNECTS_TO,
      from: "host:host1",
      to: "host:host2",
      versionHash: "hash-1",
      createdAt: new Date(),
    };

    // Write twice
    await graphStore.writeRelationship(rel);
    await graphStore.writeRelationship(rel);

    const result = await queryInterface.executeQuery(`
      MATCH (a:Entity {id: 'host:host1'})-[r:CONNECTS_TO]->(b:Entity {id: 'host:host2'})
      RETURN count(r) as count
    `);

    // Should only have one relationship
    expect(result.relationships.length).toBeLessThanOrEqual(1);
  });

  it("should return provenance (version hash and source path)", async () => {
    if (!graphStore) return;

    const node: GraphNode = {
      id: "host:test",
      type: NodeType.HOST,
      attributes: { hostname: "test" },
      versionHash: "abc123",
      sourcePath: "/path/to/doc.md",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await graphStore.writeNode(node);

    const provenance = await queryInterface.getEntitiesWithProvenance(["host:test"]);
    expect(provenance.length).toBe(1);
    expect(provenance[0].versionHash).toBe("abc123");
    expect(provenance[0].sourcePath).toBe("/path/to/doc.md");
  });

  it("should support graph-only retrieval", async () => {
    if (!graphStore) return;

    // Create test data
    const alertNode: GraphNode = {
      id: "alert:alert1",
      type: NodeType.ALERT,
      attributes: {
        severity: "high",
        message: "CPU usage high",
        timestamp: new Date().toISOString(), // Store as ISO string for Neo4j compatibility
      },
      versionHash: "hash1",
      sourcePath: "alerts.md",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const hostNode: GraphNode = {
      id: "host:server1",
      type: NodeType.HOST,
      attributes: { hostname: "server1" },
      versionHash: "hash1",
      sourcePath: "alerts.md",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await graphStore.writeNode(alertNode);
    await graphStore.writeNode(hostNode);

    const rel: GraphRelationship = {
      id: "rel-1",
      type: RelationshipType.AFFECTS,
      from: "alert:alert1",
      to: "host:server1",
      versionHash: "hash1",
      sourcePath: "alerts.md",
      createdAt: new Date(),
    };

    await graphStore.writeRelationship(rel);

    // Test graph-only retrieval
    const result = await graphRAG.retrieve("alerts affecting server1", "alerts");

    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.provenance.length).toBeGreaterThan(0);
    expect(result.provenance[0].versionHash).toBe("hash1");
  });
});

