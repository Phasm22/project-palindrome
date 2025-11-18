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
import type { ProxmoxApiConfig } from "../src/tools/proxmox/client";

async function main() {
  const args = process.argv.slice(2);
  
  // Parse arguments
  const reindex = args.includes("--reindex");
  const noRedact = args.includes("--no-redact");
  const aclGroupIndex = args.indexOf("--acl-group");
  const aclGroup = aclGroupIndex >= 0 && args[aclGroupIndex + 1] 
    ? args[aclGroupIndex + 1] 
    : (process.env.PCE_USER_ACL_GROUP || "ops");

  // Validate Proxmox environment variables
  const proxmoxUrl = process.env.PROXMOX_URL;
  const proxmoxTokenId = process.env.PROXMOX_TOKEN_ID;
  const proxmoxTokenSecret = process.env.PROXMOX_TOKEN_SECRET;

  if (!proxmoxUrl || !proxmoxTokenId || !proxmoxTokenSecret) {
    console.error("Error: PROXMOX_URL, PROXMOX_TOKEN_ID, and PROXMOX_TOKEN_SECRET must be set");
    process.exit(1);
  }

  const proxmoxConfig: ProxmoxApiConfig = {
    url: proxmoxUrl,
    tokenId: proxmoxTokenId,
    tokenSecret: proxmoxTokenSecret,
    verifySsl: process.env.PROXMOX_VERIFY_SSL !== "false",
  };

  try {
    pceLogger.info("Initializing Proxmox ingestion components");

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

    // Initialize Pipelines
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

    // Initialize Proxmox Ingestion Orchestrator
    const orchestrator = new ProxmoxIngestionOrchestrator(
      vectorPipeline,
      graphPipeline,
      graphStore,
      proxmoxConfig
    );

    // Run ingestion
    pceLogger.info("Starting Proxmox inventory ingestion", {
      aclGroup,
      redact: !noRedact,
      reindex,
    });

    const result = await orchestrator.ingestProxmoxInventory({
      aclGroup,
      redact: !noRedact,
      reindex,
    });

    // Print results
    console.log("\n=== Proxmox Ingestion Complete ===");
    console.log(`Vector Store:`);
    console.log(`  Documents Processed: ${result.vectorIngestion.documentsProcessed}`);
    console.log(`  Chunks Indexed: ${result.vectorIngestion.chunksIndexed}`);
    console.log(`\nGraph Store:`);
    console.log(`  Nodes Written: ${result.graphIngestion.nodesWritten}`);
    console.log(`  Relationships Written: ${result.graphIngestion.relationshipsWritten}`);
    console.log(`\nProvenance:`);
    console.log(`  Version Hashes: ${result.provenance.versionHashes.length}`);
    console.log(`  Provenance IDs: ${result.provenance.provenanceIds.length}`);

    // Close graph store connection
    await graphStore.close();

    pceLogger.info("Proxmox ingestion completed successfully");
    process.exit(0);
  } catch (error: any) {
    pceLogger.error("Proxmox ingestion failed", { error: error.message, stack: error.stack });
    console.error("\nError:", error.message);
    process.exit(1);
  }
}

main();

