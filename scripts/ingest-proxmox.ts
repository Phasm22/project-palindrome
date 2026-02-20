#!/usr/bin/env bun

/**
 * Proxmox Inventory Ingestion Script
 * TL-2A.6: CLI-driven ingestion of Proxmox inventory into PCE
 * 
 * Usage: bun run scripts/ingest-proxmox.ts [--reindex] [--no-redact] [--acl-group <group>]
 */

import {
  SnapshotLog,
  RawDocumentStorage,
  Redactor,
  EmbeddingService,
  QdrantVectorStore,
  IngestionPipeline,
  GraphIngestionPipeline,
  Neo4jGraphStore,
  ProxmoxIngestionOrchestrator,
  pceLogger,
} from "../src/pce/index";
import { getProxmoxEndpointConfigs } from "../src/tools/proxmox/config";

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const reindex = args.includes("--reindex");
  const noRedact = args.includes("--no-redact");
  const aclGroupIndex = args.indexOf("--acl-group");
  const aclGroup = aclGroupIndex >= 0 && args[aclGroupIndex + 1]
    ? args[aclGroupIndex + 1]
    : (process.env.PCE_USER_ACL_GROUP || "ops");

  // Resolve all configured Proxmox endpoints (cluster + proxBig)
  const endpointConfigs = getProxmoxEndpointConfigs();
  if (endpointConfigs.length === 0) {
    console.error("Error: No Proxmox endpoints configured. Set PROXMOX_URL and at least one complete token pair (for example CLUSTER_TF_TOKEN_ID+PROXMOX_CLUSTER_TF_SECRET or PROXBIG_TF_TOKEN_ID+PROXBIG_TF_SECRET).");
    process.exit(1);
  }

  try {
    pceLogger.info("Initializing Proxmox ingestion components", {
      endpoints: endpointConfigs.map(c => c.label),
    });

    // Initialize DLM
    const snapshotLog = new SnapshotLog();
    await snapshotLog.initialize();

    const rawStorage = new RawDocumentStorage();
    await rawStorage.initialize();

    // Initialize Redaction
    const redactor = new Redactor();

    // Initialize Vector Store
    const embeddingService = new EmbeddingService();
    const vectorStore = new QdrantVectorStore();
    await vectorStore.initializeCollection(embeddingService.getDimension());

    // Initialize Graph Store
    const graphStore = new Neo4jGraphStore();
    await graphStore.connect();
    await graphStore.createIndexes();

    // Initialize Pipelines (shared across all endpoints)
    const vectorPipeline = new IngestionPipeline(
      snapshotLog,
      rawStorage,
      redactor,
      embeddingService,
      vectorStore
    );

    const graphPipeline = new GraphIngestionPipeline(
      snapshotLog,
      rawStorage,
      redactor,
      graphStore
    );

    // Ingest each endpoint
    let totalVectorDocs = 0;
    let totalVectorChunks = 0;
    let totalGraphNodes = 0;
    let totalGraphRels = 0;

    for (const endpointConfig of endpointConfigs) {
      pceLogger.info("Starting Proxmox inventory ingestion", {
        endpoint: endpointConfig.label,
        url: endpointConfig.url,
        aclGroup,
        redact: !noRedact,
        reindex,
      });

      const orchestrator = new ProxmoxIngestionOrchestrator(
        vectorPipeline,
        graphPipeline,
        graphStore,
        {
          url: endpointConfig.url,
          tokenId: endpointConfig.tokenId,
          tokenSecret: endpointConfig.tokenSecret,
          verifySsl: endpointConfig.verifySsl,
        }
      );

      const result = await orchestrator.ingestProxmoxInventory({
        aclGroup,
        redact: !noRedact,
        reindex,
      });

      console.log(`\n=== [${endpointConfig.label}] Ingestion Complete ===`);
      console.log(`Vector Store:`);
      console.log(`  Documents Processed: ${result.vectorIngestion.documentsProcessed}`);
      console.log(`  Chunks Indexed: ${result.vectorIngestion.chunksIndexed}`);
      console.log(`\nGraph Store:`);
      console.log(`  Nodes Written: ${result.graphIngestion.nodesWritten}`);
      console.log(`  Relationships Written: ${result.graphIngestion.relationshipsWritten}`);

      totalVectorDocs += result.vectorIngestion.documentsProcessed;
      totalVectorChunks += result.vectorIngestion.chunksIndexed;
      totalGraphNodes += result.graphIngestion.nodesWritten;
      totalGraphRels += result.graphIngestion.relationshipsWritten;
    }

    if (endpointConfigs.length > 1) {
      console.log(`\n=== Totals (${endpointConfigs.length} endpoints) ===`);
      console.log(`  Vector Docs: ${totalVectorDocs}  Chunks: ${totalVectorChunks}`);
      console.log(`  Graph Nodes: ${totalGraphNodes}  Relationships: ${totalGraphRels}`);
    }

    // Close graph store connection
    await graphStore.close();

    pceLogger.info("Proxmox ingestion completed successfully", {
      endpoints: endpointConfigs.map(c => c.label),
    });
    process.exit(0);
  } catch (error: any) {
    pceLogger.error("Proxmox ingestion failed", { error: error.message, stack: error.stack });
    console.error("\nError:", error.message);
    process.exit(1);
  }
}

main();
