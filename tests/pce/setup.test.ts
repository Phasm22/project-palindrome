/**
 * PCE Setup Tests
 * Verify all components can be imported and initialized
 */

import { describe, it, expect } from "bun:test";

describe("PCE Module Setup", () => {
  it("should export all DLM components", async () => {
    const dlm = await import("../../src/pce/dlm");
    
    expect(dlm.generateSHA256Hash).toBeDefined();
    expect(dlm.SnapshotLog).toBeDefined();
    expect(dlm.RawDocumentStorage).toBeDefined();
  });

  it("should export all redaction components", async () => {
    const redaction = await import("../../src/pce/redaction");
    
    expect(redaction.Redactor).toBeDefined();
    expect(redaction.chunkDocument).toBeDefined();
    expect(redaction.runRedactionTests).toBeDefined();
  });

  it("should export all vector components", async () => {
    const vector = await import("../../src/pce/vector");
    
    expect(vector.QdrantVectorStore).toBeDefined();
    expect(vector.EmbeddingService).toBeDefined();
  });

  it("should export all RAG components", async () => {
    const rag = await import("../../src/pce/rag");
    
    expect(rag.RetrievalService).toBeDefined();
    expect(rag.GenerationService).toBeDefined();
    expect(rag.RAGOrchestrator).toBeDefined();
  });

  it("should export ingestion pipeline", async () => {
    const ingestion = await import("../../src/pce/ingestion");
    
    expect(ingestion.IngestionPipeline).toBeDefined();
  });

  it("should export types", async () => {
    const types = await import("../../src/pce/types");
    
    expect(types).toBeDefined();
  });
});

