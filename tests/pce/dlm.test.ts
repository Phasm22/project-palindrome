/**
 * PCE DLM Tests
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { generateSHA256Hash, hashString, SnapshotLog, RawDocumentStorage } from "../../src/pce/dlm";
import { promises as fs } from "fs";
import { join } from "path";

const TEST_DIR = "./.pce-test";

describe("DLM - Hashing", () => {
  it("should generate consistent SHA-256 hash", () => {
    const text = "test content";
    const hash1 = hashString(text);
    const hash2 = hashString(text);
    
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex string length
  });

  it("should generate different hashes for different content", () => {
    const hash1 = hashString("content 1");
    const hash2 = hashString("content 2");
    
    expect(hash1).not.toBe(hash2);
  });
});

describe("DLM - Snapshot Log", () => {
  let snapshotLog: SnapshotLog;
  const testLogPath = join(TEST_DIR, "snapshots-test.json");

  beforeEach(async () => {
    // Clean up
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {}
    
    snapshotLog = new SnapshotLog(testLogPath);
    await snapshotLog.initialize();
  });

  it("should detect NEW document", async () => {
    const testFile = join(TEST_DIR, "test-new.txt");
    await fs.mkdir(TEST_DIR, { recursive: true });
    await fs.writeFile(testFile, "test content");

    const result = await snapshotLog.detectChange(testFile, "generic_text", "admin");
    
    expect(result.status).toBe("NEW");
    expect(result.snapshot).toBeNull();
  });

  it("should detect UNCHANGED document", async () => {
    const testFile = join(TEST_DIR, "test-unchanged.txt");
    await fs.mkdir(TEST_DIR, { recursive: true });
    await fs.writeFile(testFile, "test content");

    // First ingestion
    await snapshotLog.detectChange(testFile, "generic_text", "admin");
    
    // Second ingestion - should be unchanged
    const result = await snapshotLog.detectChange(testFile, "generic_text", "admin");
    
    expect(result.status).toBe("UNCHANGED");
  });

  it("should detect MODIFIED document", async () => {
    const testFile = join(TEST_DIR, "test-modified.txt");
    await fs.mkdir(TEST_DIR, { recursive: true });
    await fs.writeFile(testFile, "test content");

    // First ingestion
    await snapshotLog.detectChange(testFile, "generic_text", "admin");
    
    // Modify file
    await fs.writeFile(testFile, "modified content");
    
    // Second ingestion - should be modified
    const result = await snapshotLog.detectChange(testFile, "generic_text", "admin");
    
    expect(result.status).toBe("MODIFIED");
  });
});

describe("DLM - Raw Document Storage", () => {
  let storage: RawDocumentStorage;
  const testStoragePath = join(TEST_DIR, "raw-storage");

  beforeEach(async () => {
    try {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
    } catch {}
    
    storage = new RawDocumentStorage(testStoragePath);
    await storage.initialize();
  });

  it("should store and retrieve document", async () => {
    const content = "test document content";
    const storedPath = await storage.storeDocument("test.txt", content);
    
    expect(storedPath).toBeTruthy();
    
    const retrieved = await storage.retrieveDocument(
      storedPath.split("/").pop()!.split(".")[0],
      "txt"
    );
    
    expect(retrieved.toString()).toBe(content);
  });

  it("should deduplicate identical documents", async () => {
    const content = "same content";
    const path1 = await storage.storeDocument("file1.txt", content);
    const path2 = await storage.storeDocument("file2.txt", content);
    
    // Should have same hash, so same storage path
    expect(path1).toBe(path2);
  });
});

