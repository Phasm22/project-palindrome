/**
 * Main Ingestion Pipeline
 * Orchestrates: DLM -> Redaction -> Chunking -> Embedding -> Indexing
 */

import { promises as fs } from "fs";
import type { DocumentType, ACLGroup, DocumentChunk } from "../types";
import { SnapshotLog, RawDocumentStorage } from "../dlm";
import { Redactor, chunkDocument } from "../redaction";
import { EmbeddingService } from "../vector/embeddings";
import { QdrantVectorStore } from "../vector/qdrant-client";
import { pceLogger } from "../utils/logger";

export interface IngestionOptions {
  documentType: DocumentType;
  aclGroup: ACLGroup;
  redact: boolean;
  reindex: boolean; // If true, delete old chunks before indexing
}

export class IngestionPipeline {
  private snapshotLog: SnapshotLog;
  private rawStorage: RawDocumentStorage;
  private redactor: Redactor;
  private embeddingService: EmbeddingService;
  private vectorStore: QdrantVectorStore;

  constructor(
    snapshotLog: SnapshotLog,
    rawStorage: RawDocumentStorage,
    redactor: Redactor,
    embeddingService: EmbeddingService,
    vectorStore: QdrantVectorStore
  ) {
    this.snapshotLog = snapshotLog;
    this.rawStorage = rawStorage;
    this.redactor = redactor;
    this.embeddingService = embeddingService;
    this.vectorStore = vectorStore;
  }

  /**
   * Ingest a document file
   */
  async ingestFile(filePath: string, options: IngestionOptions): Promise<{
    status: "NEW" | "MODIFIED" | "UNCHANGED";
    chunksIndexed: number;
  }> {
    try {
      pceLogger.info(`Starting ingestion: ${filePath}`, options);

      // Step 1: Read file
      const fileContent = await fs.readFile(filePath, "utf-8");

      // Step 2: DLM - Detect changes
      const changeResult = await this.snapshotLog.detectChange(
        filePath,
        options.documentType,
        options.aclGroup
      );

      if (changeResult.status === "UNCHANGED" && !options.reindex) {
        pceLogger.info(`Document unchanged, skipping: ${filePath}`);
        return { status: "UNCHANGED", chunksIndexed: 0 };
      }

      // Step 3: Store raw document
      await this.rawStorage.storeDocumentFromFile(filePath);

      // Step 4: Redact if enabled
      let processedText = fileContent;
      if (options.redact) {
        const redactionResult = this.redactor.redact(fileContent);
        processedText = redactionResult.redactedText;
        pceLogger.info(`Redacted document`, {
          redactions: redactionResult.redactions.length,
        });
      }

      // Step 5: Chunk document
      const chunks = chunkDocument(
        processedText,
        options.documentType,
        {
          versionHash: changeResult.currentHash,
          aclGroup: options.aclGroup,
          sourceType: options.documentType,
          sourcePath: filePath,
          timestamp: new Date(),
        }
      );

      pceLogger.info(`Chunked document into ${chunks.length} chunks`);

      // Step 6: Delete old chunks if reindexing
      if (options.reindex && changeResult.snapshot) {
        await this.vectorStore.deleteByVersionHash(changeResult.snapshot.sha256Hash);
      }

      // Step 7: Generate embeddings
      const texts = chunks.map((chunk) => chunk.text);
      const embeddings = await this.embeddingService.embedBatch(texts);

      // Step 8: Index chunks
      await this.vectorStore.indexChunks(chunks, embeddings);

      pceLogger.info(`Successfully ingested document`, {
        filePath,
        status: changeResult.status,
        chunksIndexed: chunks.length,
      });

      return {
        status: changeResult.status,
        chunksIndexed: chunks.length,
      };
    } catch (error: any) {
      pceLogger.error(`Failed to ingest document: ${filePath}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Ingest multiple files
   */
  async ingestFiles(
    filePaths: string[],
    options: IngestionOptions
  ): Promise<Array<{ filePath: string; status: "NEW" | "MODIFIED" | "UNCHANGED"; chunksIndexed: number }>> {
    const results = [];

    for (const filePath of filePaths) {
      try {
        const result = await this.ingestFile(filePath, options);
        results.push({ filePath, ...result });
      } catch (error: any) {
        pceLogger.error(`Failed to ingest: ${filePath}`, { error: error.message });
        results.push({
          filePath,
          status: "UNCHANGED" as const,
          chunksIndexed: 0,
        });
      }
    }

    return results;
  }
}

