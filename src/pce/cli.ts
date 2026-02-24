#!/usr/bin/env bun

/**
 * PCE CLI - Simple command-line interface for PCE operations
 */

import {
  SnapshotLog,
  RawDocumentStorage,
  Redactor,
  EmbeddingService,
  QdrantVectorStore,
  IngestionPipeline,
  RetrievalService,
  GenerationService,
  RAGOrchestrator,
  pceLogger,
} from "./index";
import { isTestOrScratchPath } from "./ingestion/path-guard";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "test-redaction") {
    // Task 2.4: Run redaction test harness
    const { runRedactionTests } = await import("./redaction/test-harness");
    const redactor = new Redactor();
    const results = runRedactionTests(redactor);
    
    console.log("\n=== Redaction Test Results ===");
    console.log(`Passed: ${results.passed}`);
    console.log(`Failed: ${results.failed}`);
    console.log("\nDetails:");
    results.results.forEach((result) => {
      console.log(`  ${result.testCase}: ${result.passed ? "✓" : "✗"}`);
      if (result.issues.length > 0) {
        result.issues.forEach((issue) => console.log(`    - ${issue}`));
      }
    });
    
    process.exit(results.failed > 0 ? 1 : 0);
  } else if (command === "ingest") {
    // Ingest a document
    const ingestArgs = args.slice(1).filter((a) => a !== "--allow-test-path");
    const allowTestPath = args.includes("--allow-test-path");
    const filePath = ingestArgs[0];
    const documentType = (ingestArgs[1] || "generic_text") as any;
    const aclGroup = ingestArgs[2] || "admin";

    if (!filePath) {
      console.error("Usage: pce ingest <file-path> [document-type] [acl-group] [--allow-test-path]");
      process.exit(1);
    }

    if (isTestOrScratchPath(filePath) && !allowTestPath) {
      console.error(
        "Path is under a test/scratch directory. Use --allow-test-path to override."
      );
      process.exit(1);
    }

    // Initialize components
    const snapshotLog = new SnapshotLog();
    await snapshotLog.initialize();
    
    const rawStorage = new RawDocumentStorage();
    await rawStorage.initialize();
    
    const redactor = new Redactor();
    const embeddingService = new EmbeddingService();
    const vectorStore = new QdrantVectorStore();
    await vectorStore.initializeCollection(embeddingService.getDimension());
    
    const pipeline = new IngestionPipeline(
      snapshotLog,
      rawStorage,
      redactor,
      embeddingService,
      vectorStore
    );
    
    const result = await pipeline.ingestFile(filePath, {
      documentType,
      aclGroup,
      redact: true,
      reindex: false,
    });
    
    console.log(`Ingestion complete: ${result.status}, ${result.chunksIndexed} chunks indexed`);
  } else if (command === "query") {
    // Query the RAG system
    const query = args.slice(1).join(" ");
    const aclGroup = process.env.PCE_USER_ACL_GROUP || "admin";
    
    if (!query) {
      console.error("Usage: pce query <your question>");
      process.exit(1);
    }

    // Initialize components
    const embeddingService = new EmbeddingService();
    const vectorStore = new QdrantVectorStore();
    await vectorStore.initializeCollection(embeddingService.getDimension());
    
    const retrievalService = new RetrievalService(
      vectorStore,
      embeddingService
    );
    
    const generationService = new GenerationService();
    const orchestrator = new RAGOrchestrator(retrievalService, generationService);
    
    const response = await orchestrator.query(query, aclGroup);
    
    console.log("\n=== Answer ===");
    console.log(response.answer);
    console.log("\n=== Sources ===");
    response.sources.forEach((source, index) => {
      console.log(`${index + 1}. ${source.sourcePath} (score: ${source.score.toFixed(3)})`);
    });
  } else if (command === "init") {
    // Initialize vector store
    const embeddingService = new EmbeddingService();
    const vectorStore = new QdrantVectorStore();
    await vectorStore.initializeCollection(embeddingService.getDimension());
    console.log("Vector store initialized");
  } else {
    console.log("PCE CLI - Pervasive Context Engine");
    console.log("\nCommands:");
    console.log("  test-redaction              - Run redaction test harness");
    console.log("  ingest <file> [type] [acl]  - Ingest a document");
    console.log("  query <question>            - Query the RAG system");
    console.log("  init                        - Initialize vector store");
    process.exit(0);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

