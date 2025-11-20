#!/usr/bin/env bun
/**
 * Topology Ingestion Script
 * Ingests topology.yaml into the knowledge graph
 */

import { join } from "path";
import { Neo4jGraphStore } from "../src/pce/kg/indexation/neo4j-client";
import { TopologyIngestionOrchestrator } from "../src/pce/ingestion/topology-ingestion";
import { pceLogger } from "../src/pce/utils/logger";

const TOPOLOGY_PATH = process.env.TOPOLOGY_PATH || join(process.cwd(), "docs", "topology.yaml");
const NEO4J_URI = process.env.NEO4J_URI || "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "password";
const ACL_GROUP = (process.env.ACL_GROUP || "viewer") as "admin" | "operator" | "viewer";

async function main() {
  try {
    pceLogger.info("Starting topology ingestion", { topologyPath: TOPOLOGY_PATH });

    // Connect to Neo4j
    const graphStore = new Neo4jGraphStore(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);
    await graphStore.connect();
    await graphStore.createIndexes();

    // Ingest topology
    const result = await TopologyIngestionOrchestrator.ingestTopology(
      TOPOLOGY_PATH,
      graphStore,
      ACL_GROUP
    );

    pceLogger.info("Topology ingestion complete", result);

    // Close connection
    await graphStore.close();

    console.log(`✅ Ingested ${result.nodesWritten} nodes and ${result.relationshipsWritten} relationships`);
  } catch (error: any) {
    pceLogger.error("Topology ingestion failed", { error: error.message });
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

main();

