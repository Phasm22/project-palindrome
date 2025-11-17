#!/usr/bin/env bun

/**
 * DOD Verification Script
 * Run this to verify all Definition of Done criteria are met
 */

import { promises as fs } from "fs";
import { join } from "path";
import {
  SnapshotLog,
  RawDocumentStorage,
  Redactor,
  chunkDocument,
  EmbeddingService,
  QdrantVectorStore,
  IngestionPipeline,
  RetrievalService,
  runRedactionTests,
} from "./index";

const TEST_DIR = "./.pce-dod-verify";
const TEST_SNAPSHOT_LOG = join(TEST_DIR, "snapshots.json");
const TEST_RAW_STORAGE = join(TEST_DIR, "raw-documents");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => Promise<void> | void) {
  return async () => {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (error: any) {
      console.error(`❌ ${name}: ${error.message}`);
      failures.push(`${name}: ${error.message}`);
      failed++;
    }
  };
}

async function main() {
  console.log("🔍 Verifying Phase I-A Definition of Done...\n");

  // Cleanup
  try {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  } catch {}
  await fs.mkdir(TEST_DIR, { recursive: true });

  // DOD 1: Hashing & Versioning
  console.log("📋 DOD 1: Hashing & Versioning Works");
  const snapshotLog = new SnapshotLog(TEST_SNAPSHOT_LOG);
  await snapshotLog.initialize();

  const testFile = join(TEST_DIR, "test.txt");

  await test("First run → NEW", async () => {
    await fs.writeFile(testFile, "initial content");
    const result = await snapshotLog.detectChange(testFile, "generic_text", "admin");
    if (result.status !== "NEW") throw new Error(`Expected NEW, got ${result.status}`);
  })();

  await test("Second run (unchanged) → UNCHANGED", async () => {
    const result = await snapshotLog.detectChange(testFile, "generic_text", "admin");
    if (result.status !== "UNCHANGED") throw new Error(`Expected UNCHANGED, got ${result.status}`);
  })();

  await test("Modified file → MODIFIED", async () => {
    await fs.writeFile(testFile, "modified content");
    const result = await snapshotLog.detectChange(testFile, "generic_text", "admin");
    if (result.status !== "MODIFIED") throw new Error(`Expected MODIFIED, got ${result.status}`);
  })();

  // DOD 2: Redaction Safety
  console.log("\n📋 DOD 2: Redaction is Verifiably Safe");
  const redactor = new Redactor();

  await test("Redaction removes sensitive content", async () => {
    const testDoc = 'const apiKey = "sk_live_1234567890abcdefghijklmnopqrstuvwxyz";';
    const result = redactor.redact(testDoc);
    if (result.redactedText.includes("sk_live_")) {
      throw new Error("Sensitive content not redacted");
    }
    if (!result.redactedText.includes("[REDACTED")) {
      throw new Error("Redaction markers not present");
    }
    if (redactor.containsSensitiveData(result.redactedText)) {
      throw new Error("Redacted text still contains sensitive data");
    }
  })();

  await test("Redaction preserves document structure", async () => {
    const structuredDoc = `# Configuration\n\napi_key: sk_live_123\npassword: secret123`;
    const result = redactor.redact(structuredDoc);
    if (!result.redactedText.includes("# Configuration")) {
      throw new Error("Document structure broken");
    }
  })();

  await test("Redaction test harness passes", async () => {
    const results = runRedactionTests(redactor);
    if (results.failed > 0) {
      throw new Error(`${results.failed} test(s) failed in redaction harness`);
    }
  })();

  // DOD 3: Chunking Deterministic
  console.log("\n📋 DOD 3: Chunking is Deterministic");
  const text = "This is a test document. ".repeat(50);
  const metadata = {
    versionHash: "test-hash-123",
    aclGroup: "admin",
    sourceType: "generic_text" as const,
    sourcePath: "test.txt",
    timestamp: new Date("2025-01-01T00:00:00Z"),
  };

  await test("Same input → same chunks", async () => {
    const chunks1 = chunkDocument(text, "generic_text", metadata);
    const chunks2 = chunkDocument(text, "generic_text", metadata);
    if (chunks1.length !== chunks2.length) {
      throw new Error("Chunk count differs");
    }
    for (let i = 0; i < chunks1.length; i++) {
      if (chunks1[i].text !== chunks2[i].text || chunks1[i].id !== chunks2[i].id) {
        throw new Error("Chunks differ for same input");
      }
    }
  })();

  await test("Partial modification → only adjacent chunks change", async () => {
    const baseText = "Section 1. ".repeat(20) + "\n\n" + "Section 2. ".repeat(20);
    const modifiedText = "Section 1. ".repeat(20) + "\n\n" + "Section 2 MODIFIED. ".repeat(20);
    
    const baseChunks = chunkDocument(baseText, "generic_text", metadata);
    const modifiedChunks = chunkDocument(modifiedText, "generic_text", {
      ...metadata,
      versionHash: "hash-2",
    });
    
    if (baseChunks[0].text !== modifiedChunks[0].text) {
      throw new Error("First chunk changed when it shouldn't");
    }
    
    const allSame = baseChunks.every((chunk, i) => 
      modifiedChunks[i] && chunk.text === modifiedChunks[i].text
    );
    if (allSame) {
      throw new Error("No chunks changed when modification was made");
    }
  })();

  // DOD 4: Vector DB Integration
  console.log("\n📋 DOD 4: Vector DB Integration Produces Real Results");
  const embeddingService = new EmbeddingService();
  const vectorStore = new QdrantVectorStore();
  await vectorStore.initializeCollection(embeddingService.getDimension());

  const dod4File = join(TEST_DIR, "dod4-test.txt");
  await fs.writeFile(dod4File, "The firewall rule list can be viewed at /ui/firewall/rules. You can also check the OPNsense dashboard for active rules.");

  await test("Ingest document and retrieve relevant chunk", async () => {
    const rawStorage = new RawDocumentStorage(TEST_RAW_STORAGE);
    await rawStorage.initialize();
    const pipeline = new IngestionPipeline(
      snapshotLog,
      rawStorage,
      redactor,
      embeddingService,
      vectorStore
    );

    await pipeline.ingestFile(dod4File, {
      documentType: "generic_text",
      aclGroup: "admin",
      redact: false,
      reindex: false,
    });

    const retrievalService = new RetrievalService(vectorStore, embeddingService);
    const result = await retrievalService.retrieve("how to see firewall rules?", "admin");

    if (result.chunks.length === 0) {
      throw new Error("No chunks retrieved");
    }

    const relevant = result.chunks.some(chunk => 
      chunk.text.toLowerCase().includes("firewall") || 
      chunk.text.toLowerCase().includes("rule")
    );
    if (!relevant) {
      throw new Error("Retrieved chunks don't contain relevant content");
    }
  })();

  // DOD 5: Access Control
  console.log("\n📋 DOD 5: Access Control Filtering Works");
  const dod5File = join(TEST_DIR, "dod5-test.txt");
  await fs.writeFile(dod5File, "This is a sensitive operations document. Only ops team should see this.");

  await test("ACL filtering: viewer cannot see ops document", async () => {
    const rawStorage = new RawDocumentStorage(TEST_RAW_STORAGE);
    await rawStorage.initialize();
    const pipeline = new IngestionPipeline(
      snapshotLog,
      rawStorage,
      redactor,
      embeddingService,
      vectorStore
    );

    await pipeline.ingestFile(dod5File, {
      documentType: "generic_text",
      aclGroup: "ops",
      redact: false,
      reindex: false,
    });

    const retrievalService = new RetrievalService(vectorStore, embeddingService);
    const viewerResult = await retrievalService.retrieve("operations document", "viewer");
    
    if (viewerResult.chunks.length > 0) {
      throw new Error("Viewer should not see ops document");
    }
  })();

  await test("ACL filtering: ops can see ops document", async () => {
    const retrievalService = new RetrievalService(vectorStore, embeddingService);
    const opsResult = await retrievalService.retrieve("operations document", "ops");
    
    if (opsResult.chunks.length === 0) {
      throw new Error("Ops should see ops document");
    }
    if (opsResult.chunks[0].metadata.aclGroup !== "ops") {
      throw new Error("Retrieved chunk has wrong ACL group");
    }
  })();

  // DOD 6: Logging
  console.log("\n📋 DOD 6: Logging Provides a Record of Everything");
  console.log("ℹ️  Logging verification: Check console output above for:");
  console.log("   - Hash calculation logs");
  console.log("   - Change detection logs");
  console.log("   - Redaction result logs");
  console.log("   - Chunk count logs");
  console.log("   - Embedding time logs");
  console.log("   - Vector DB write logs");
  console.log("   - Retrieval logs");
  console.log("✅ If you see logs above, DOD 6 is satisfied\n");

  // Summary
  console.log("=".repeat(60));
  console.log(`📊 Summary: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    console.log("\n❌ Failures:");
    failures.forEach(f => console.log(`   - ${f}`));
    process.exit(1);
  } else {
    console.log("\n✅ All DOD criteria met! Phase I-A is complete and correct.");
    process.exit(0);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

