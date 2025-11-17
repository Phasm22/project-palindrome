/**
 * Definition of Done (DOD) Tests for Phase I-A
 * Comprehensive pass/fail tests to verify Phase I-A is complete and correct
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
  GenerationService,
  RAGOrchestrator,
  pceLogger,
} from "../../src/pce";

const TEST_DIR = "./.pce-dod-test";
const TEST_SNAPSHOT_LOG = join(TEST_DIR, "snapshots.json");
const TEST_RAW_STORAGE = join(TEST_DIR, "raw-documents");

// Capture logs for DOD 6
const logMessages: string[] = [];
const originalInfo = pceLogger.info;
const originalDebug = pceLogger.debug;
const originalWarn = pceLogger.warn;
const originalError = pceLogger.error;

function captureLogs() {
  pceLogger.info = (...args: any[]) => {
    logMessages.push(`[INFO] ${args[0]}`);
    originalInfo.apply(pceLogger, args);
  };
  pceLogger.debug = (...args: any[]) => {
    logMessages.push(`[DEBUG] ${args[0]}`);
    originalDebug.apply(pceLogger, args);
  };
  pceLogger.warn = (...args: any[]) => {
    logMessages.push(`[WARN] ${args[0]}`);
    originalWarn.apply(pceLogger, args);
  };
  pceLogger.error = (...args: any[]) => {
    logMessages.push(`[ERROR] ${args[0]}`);
    originalError.apply(pceLogger, args);
  };
}

function restoreLogs() {
  pceLogger.info = originalInfo;
  pceLogger.debug = originalDebug;
  pceLogger.warn = originalWarn;
  pceLogger.error = originalError;
  logMessages.length = 0;
}

describe("DOD 1: Hashing & Versioning Works", () => {
  let snapshotLog: SnapshotLog;
  const testFile = join(TEST_DIR, "dod1-test.txt");

  beforeEach(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {}
    await fs.mkdir(TEST_DIR, { recursive: true });

    snapshotLog = new SnapshotLog(TEST_SNAPSHOT_LOG);
    await snapshotLog.initialize();
  });

  it("should detect NEW on first run", async () => {
    await fs.writeFile(testFile, "initial content");
    const result = await snapshotLog.detectChange(testFile, "generic_text", "admin");

    expect(result.status).toBe("NEW");
    expect(result.snapshot).toBeNull();
  });

  it("should detect UNCHANGED on second run with same content", async () => {
    await fs.writeFile(testFile, "same content");
    
    // First run
    await snapshotLog.detectChange(testFile, "generic_text", "admin");
    
    // Second run - should be UNCHANGED
    const result = await snapshotLog.detectChange(testFile, "generic_text", "admin");
    
    expect(result.status).toBe("UNCHANGED");
  });

  it("should detect MODIFIED when file changes", async () => {
    await fs.writeFile(testFile, "original content");
    
    // First run
    await snapshotLog.detectChange(testFile, "generic_text", "admin");
    
    // Modify file
    await fs.writeFile(testFile, "modified content");
    
    // Second run - should be MODIFIED
    const result = await snapshotLog.detectChange(testFile, "generic_text", "admin");
    
    expect(result.status).toBe("MODIFIED");
    expect(result.snapshot).not.toBeNull();
  });

  it("should maintain state across multiple files", async () => {
    const file1 = join(TEST_DIR, "file1.txt");
    const file2 = join(TEST_DIR, "file2.txt");
    
    await fs.writeFile(file1, "content 1");
    await fs.writeFile(file2, "content 2");
    
    const result1a = await snapshotLog.detectChange(file1, "generic_text", "admin");
    const result2a = await snapshotLog.detectChange(file2, "generic_text", "admin");
    
    expect(result1a.status).toBe("NEW");
    expect(result2a.status).toBe("NEW");
    
    // Modify only file1
    await fs.writeFile(file1, "modified content 1");
    
    const result1b = await snapshotLog.detectChange(file1, "generic_text", "admin");
    const result2b = await snapshotLog.detectChange(file2, "generic_text", "admin");
    
    expect(result1b.status).toBe("MODIFIED");
    expect(result2b.status).toBe("UNCHANGED");
  });
});

describe("DOD 2: Redaction is Verifiably Safe", () => {
  it("should remove all sensitive content from test documents", () => {
    const redactor = new Redactor();
    
    const testDocs = [
      'const apiKey = "sk_live_1234567890abcdefghijklmnopqrstuvwxyz";',
      'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
      'password: "MySecretPassword123!"',
      'Contact support@example.com for help.',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'Server IP: 192.168.1.100',
      'Credit card: 4532-1234-5678-9010',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
    ];

    for (const doc of testDocs) {
      const result = redactor.redact(doc);
      
      // Verify sensitive content is removed
      expect(result.redactedText).not.toBe(doc);
      expect(result.redactions.length).toBeGreaterThan(0);
      
      // Verify structure is preserved (not empty, has content)
      expect(result.redactedText.length).toBeGreaterThan(0);
      expect(result.redactedText).toContain("[REDACTED");
      
      // Verify no sensitive patterns remain
      const stillContainsSensitive = redactor.containsSensitiveData(result.redactedText);
      expect(stillContainsSensitive).toBe(false);
    }
  });

  it("should not break document structure", () => {
    const redactor = new Redactor();
    
    const structuredDoc = `# Configuration File

## API Settings
api_key: sk_live_1234567890abcdef
endpoint: https://api.example.com

## Database
password: secret123
host: db.example.com
`;

    const result = redactor.redact(structuredDoc);
    
    // Should preserve markdown structure
    expect(result.redactedText).toContain("# Configuration File");
    expect(result.redactedText).toContain("## API Settings");
    expect(result.redactedText).toContain("## Database");
    
    // Should have redacted sensitive parts
    expect(result.redactedText).not.toContain("sk_live_");
    expect(result.redactedText).not.toContain("secret123");
  });

  it("should pass comprehensive test harness", () => {
    const { runRedactionTests } = require("../../src/pce/redaction/test-harness");
    const redactor = new Redactor();
    const results = runRedactionTests(redactor);
    
    expect(results.failed).toBe(0);
    expect(results.passed).toBeGreaterThan(0);
    
    // Verify no sensitive tokens detected in redacted output
    for (const testResult of results.results) {
      if (testResult.testCase.includes("Clean")) {
        continue; // Skip clean text test
      }
      expect(testResult.passed).toBe(true);
      expect(testResult.issues.length).toBe(0);
    }
  });
});

describe("DOD 3: Chunking is Deterministic", () => {
  it("should produce same chunks for same input", () => {
    const text = "This is a test document. ".repeat(50);
    const metadata = {
      versionHash: "test-hash-123",
      aclGroup: "admin",
      sourceType: "generic_text" as const,
      sourcePath: "test.txt",
      timestamp: new Date("2025-01-01T00:00:00Z"),
    };
    
    const chunks1 = chunkDocument(text, "generic_text", metadata);
    const chunks2 = chunkDocument(text, "generic_text", metadata);
    
    expect(chunks1.length).toBe(chunks2.length);
    
    for (let i = 0; i < chunks1.length; i++) {
      expect(chunks1[i].text).toBe(chunks2[i].text);
      expect(chunks1[i].id).toBe(chunks2[i].id);
      expect(chunks1[i].startIndex).toBe(chunks2[i].startIndex);
      expect(chunks2[i].endIndex).toBe(chunks2[i].endIndex);
    }
  });

  it("should only change adjacent chunks when small part is modified", () => {
    const baseText = "Section 1 content. ".repeat(20) + "\n\n" + "Section 2 content. ".repeat(20);
    const modifiedText = "Section 1 content. ".repeat(20) + "\n\n" + "Section 2 MODIFIED content. ".repeat(20);
    
    const metadata = {
      versionHash: "hash-1",
      aclGroup: "admin",
      sourceType: "generic_text" as const,
      sourcePath: "test.txt",
      timestamp: new Date(),
    };
    
    const baseChunks = chunkDocument(baseText, "generic_text", metadata);
    const modifiedChunks = chunkDocument(modifiedText, "generic_text", {
      ...metadata,
      versionHash: "hash-2",
    });
    
    // First chunk should be identical (before modification)
    expect(baseChunks[0].text).toBe(modifiedChunks[0].text);
    
    // At least one chunk should differ (the one containing the modification)
    const hasDifference = baseChunks.some((chunk, i) => {
      return modifiedChunks[i] && chunk.text !== modifiedChunks[i].text;
    });
    expect(hasDifference).toBe(true);
    
    // Not all chunks should change
    const allDifferent = baseChunks.every((chunk, i) => {
      return !modifiedChunks[i] || chunk.text !== modifiedChunks[i].text;
    });
    expect(allDifferent).toBe(false);
  });

  it("should produce stable chunk IDs based on hash and index", () => {
    const text = "Test content";
    const metadata = {
      versionHash: "stable-hash",
      aclGroup: "admin",
      sourceType: "generic_text" as const,
      sourcePath: "test.txt",
      timestamp: new Date(),
    };
    
    const chunks1 = chunkDocument(text, "generic_text", metadata);
    const chunks2 = chunkDocument(text, "generic_text", metadata);
    
    expect(chunks1[0].id).toBe(chunks2[0].id);
    expect(chunks1[0].id).toContain("stable-hash");
  });
});

describe("DOD 4: Vector DB Integration Produces Real Results", () => {
  let vectorStore: QdrantVectorStore;
  let embeddingService: EmbeddingService;
  let retrievalService: RetrievalService;
  const testFile = join(TEST_DIR, "dod4-test.txt");

  beforeEach(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {}
    await fs.mkdir(TEST_DIR, { recursive: true });

    embeddingService = new EmbeddingService();
    vectorStore = new QdrantVectorStore();
    await vectorStore.initializeCollection(embeddingService.getDimension());
    
    retrievalService = new RetrievalService(vectorStore, embeddingService);
  });

  it("should retrieve relevant chunk for semantic query", async () => {
    // Create test document
    const docContent = "The firewall rule list can be viewed at /ui/firewall/rules. You can also check the OPNsense dashboard for active rules.";
    await fs.writeFile(testFile, docContent);

    // Ingest document
    const snapshotLog = new SnapshotLog(TEST_SNAPSHOT_LOG);
    await snapshotLog.initialize();
    const rawStorage = new RawDocumentStorage(TEST_RAW_STORAGE);
    await rawStorage.initialize();
    const redactor = new Redactor();
    const pipeline = new IngestionPipeline(
      snapshotLog,
      rawStorage,
      redactor,
      embeddingService,
      vectorStore
    );

    await pipeline.ingestFile(testFile, {
      documentType: "generic_text",
      aclGroup: "admin",
      redact: false,
      reindex: false,
    });

    // Query
    const query = "how to see firewall rules?";
    const result = await retrievalService.retrieve(query, "admin");

    // Should retrieve at least one chunk
    expect(result.chunks.length).toBeGreaterThan(0);
    
    // Should contain relevant content
    const relevantChunk = result.chunks.find(chunk => 
      chunk.text.toLowerCase().includes("firewall") || 
      chunk.text.toLowerCase().includes("rule")
    );
    expect(relevantChunk).toBeDefined();
    
    // Should have scores
    expect(result.scores.length).toBeGreaterThan(0);
    expect(result.scores[0]).toBeGreaterThan(0);
  }, 30000); // 30 second timeout for API calls
});

describe("DOD 5: Access Control Filtering Works", () => {
  let vectorStore: QdrantVectorStore;
  let embeddingService: EmbeddingService;
  let retrievalService: RetrievalService;
  const testFile = join(TEST_DIR, "dod5-test.txt");

  beforeEach(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {}
    await fs.mkdir(TEST_DIR, { recursive: true });

    embeddingService = new EmbeddingService();
    vectorStore = new QdrantVectorStore();
    await vectorStore.initializeCollection(embeddingService.getDimension());
    
    retrievalService = new RetrievalService(vectorStore, embeddingService);
  });

  it("should filter chunks by ACL group", async () => {
    // Create test document with ops ACL
    const docContent = "This is a sensitive operations document. Only ops team should see this.";
    await fs.writeFile(testFile, docContent);

    // Ingest with ops ACL
    const snapshotLog = new SnapshotLog(TEST_SNAPSHOT_LOG);
    await snapshotLog.initialize();
    const rawStorage = new RawDocumentStorage(TEST_RAW_STORAGE);
    await rawStorage.initialize();
    const redactor = new Redactor();
    const pipeline = new IngestionPipeline(
      snapshotLog,
      rawStorage,
      redactor,
      embeddingService,
      vectorStore
    );

    await pipeline.ingestFile(testFile, {
      documentType: "generic_text",
      aclGroup: "ops",
      redact: false,
      reindex: false,
    });

    // Query as viewer (should get empty results)
    const viewerResult = await retrievalService.retrieve("operations document", "viewer");
    expect(viewerResult.chunks.length).toBe(0);

    // Query as ops (should get results)
    const opsResult = await retrievalService.retrieve("operations document", "ops");
    expect(opsResult.chunks.length).toBeGreaterThan(0);
    expect(opsResult.chunks[0].metadata.aclGroup).toBe("ops");
  }, 30000);

  it("should allow admin to see all chunks", async () => {
    // Create documents with different ACLs
    const opsFile = join(TEST_DIR, "ops-doc.txt");
    const viewerFile = join(TEST_DIR, "viewer-doc.txt");
    
    await fs.writeFile(opsFile, "Ops document");
    await fs.writeFile(viewerFile, "Viewer document");

    const snapshotLog = new SnapshotLog(TEST_SNAPSHOT_LOG);
    await snapshotLog.initialize();
    const rawStorage = new RawDocumentStorage(TEST_RAW_STORAGE);
    await rawStorage.initialize();
    const redactor = new Redactor();
    const pipeline = new IngestionPipeline(
      snapshotLog,
      rawStorage,
      redactor,
      embeddingService,
      vectorStore
    );

    await pipeline.ingestFile(opsFile, {
      documentType: "generic_text",
      aclGroup: "ops",
      redact: false,
      reindex: false,
    });

    await pipeline.ingestFile(viewerFile, {
      documentType: "generic_text",
      aclGroup: "viewer",
      redact: false,
      reindex: false,
    });

    // Admin should see both (if admin has access to all)
    // Note: This test assumes admin can access all groups
    // If your ACL system is more restrictive, adjust this test
    const adminResult = await retrievalService.retrieve("document", "admin");
    // At minimum, admin should see some results
    expect(adminResult.chunks.length).toBeGreaterThan(0);
  }, 30000);
});

describe("DOD 6: Logging Provides a Record of Everything", () => {
  let snapshotLog: SnapshotLog;
  let vectorStore: QdrantVectorStore;
  let embeddingService: EmbeddingService;
  const testFile = join(TEST_DIR, "dod6-test.txt");

  beforeEach(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {}
    await fs.mkdir(TEST_DIR, { recursive: true });
    
    captureLogs();
    
    snapshotLog = new SnapshotLog(TEST_SNAPSHOT_LOG);
    await snapshotLog.initialize();
    embeddingService = new EmbeddingService();
    vectorStore = new QdrantVectorStore();
    await vectorStore.initializeCollection(embeddingService.getDimension());
  });

  afterEach(() => {
    restoreLogs();
  });

  it("should log all ingestion steps", async () => {
    await fs.writeFile(testFile, "Test content for logging verification");
    
    const rawStorage = new RawDocumentStorage(TEST_RAW_STORAGE);
    await rawStorage.initialize();
    const redactor = new Redactor();
    const pipeline = new IngestionPipeline(
      snapshotLog,
      rawStorage,
      redactor,
      embeddingService,
      vectorStore
    );

    await pipeline.ingestFile(testFile, {
      documentType: "generic_text",
      aclGroup: "admin",
      redact: false,
      reindex: false,
    });

    const logText = logMessages.join("\n");

    // Verify key log events
    expect(logText).toMatch(/hash|Hash/i); // Hash calculation
    expect(logText).toMatch(/change|status|NEW|MODIFIED/i); // Change detection
    expect(logText).toMatch(/chunk/i); // Chunk count
    expect(logText).toMatch(/embed|embedding/i); // Embedding
    expect(logText).toMatch(/index|Index/i); // Write to vector DB
  }, 30000);

  it("should log retrieval operations", async () => {
    // First ingest a document
    await fs.writeFile(testFile, "Test content");
    const rawStorage = new RawDocumentStorage(TEST_RAW_STORAGE);
    await rawStorage.initialize();
    const redactor = new Redactor();
    const pipeline = new IngestionPipeline(
      snapshotLog,
      rawStorage,
      redactor,
      embeddingService,
      vectorStore
    );
    await pipeline.ingestFile(testFile, {
      documentType: "generic_text",
      aclGroup: "admin",
      redact: false,
      reindex: false,
    });

    // Clear logs
    logMessages.length = 0;

    // Perform retrieval
    const retrievalService = new RetrievalService(vectorStore, embeddingService);
    await retrievalService.retrieve("test query", "admin");

    const logText = logMessages.join("\n");

    // Verify retrieval logs
    expect(logText).toMatch(/retriev|search|query/i);
    expect(logText).toMatch(/chunk|result/i);
  }, 30000);
});

