/**
 * End-to-End Graph Ingestion Pipeline
 * Task 7.6: End-to-End Re-Ingestion Test
 * Full pipeline: raw -> redact -> chunk -> extract -> normalize -> alias -> graph write -> graph query
 */

import { promises as fs } from "fs";
import type { DocumentType, ACLGroup } from "../types";
import { SnapshotLog, RawDocumentStorage } from "../dlm";
import { Redactor, chunkDocument } from "../redaction";
import { GraphIndexer } from "../kg/indexation/graph-indexer";
import { Neo4jGraphStore } from "../kg/indexation/neo4j-client";
import { EDLPipeline } from "../edl/pipeline";
import { pceLogger } from "../utils/logger";

export interface GraphIngestionOptions {
  documentType: DocumentType;
  aclGroup: ACLGroup;
  redact: boolean;
  reindex: boolean;
}

export interface GraphIngestionResult {
  status: "NEW" | "MODIFIED" | "UNCHANGED";
  chunksCreated: number;
  graphIndexation: {
    nodesWritten: number;
    relationshipsWritten: number;
    stats: {
      entitiesExtracted: number;
      entitiesValidated: number;
      entitiesNormalized: number;
      aliasesResolved: number;
      relationshipsExtracted: number;
    };
  };
}

/**
 * Complete Graph Ingestion Pipeline
 */
export class GraphIngestionPipeline {
  private snapshotLog: SnapshotLog;
  private rawStorage: RawDocumentStorage;
  private redactor: Redactor;
  private graphIndexer: GraphIndexer;

  constructor(
    snapshotLog: SnapshotLog,
    rawStorage: RawDocumentStorage,
    redactor: Redactor,
    graphStore: Neo4jGraphStore,
    edlPipeline?: EDLPipeline
  ) {
    this.snapshotLog = snapshotLog;
    this.rawStorage = rawStorage;
    this.redactor = redactor;
    this.graphIndexer = new GraphIndexer(graphStore, edlPipeline);
  }

  /**
   * Ingest file through complete pipeline
   */
  async ingestFile(filePath: string, options: GraphIngestionOptions): Promise<GraphIngestionResult> {
    try {
      pceLogger.info(`Starting graph ingestion: ${filePath}`, options);

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
        return {
          status: "UNCHANGED",
          chunksCreated: 0,
          graphIndexation: {
            nodesWritten: 0,
            relationshipsWritten: 0,
            stats: {
              entitiesExtracted: 0,
              entitiesValidated: 0,
              entitiesNormalized: 0,
              aliasesResolved: 0,
              relationshipsExtracted: 0,
            },
          },
        };
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

      // Step 6: Index into graph (includes EDL pipeline)
      const graphResult = options.reindex
        ? await this.graphIndexer.wipeAndReindex(chunks)
        : await this.graphIndexer.indexChunks(chunks);

      pceLogger.info("Graph ingestion complete", {
        filePath,
        status: changeResult.status,
        chunks: chunks.length,
        nodes: graphResult.nodesWritten,
        relationships: graphResult.relationshipsWritten,
      });

      return {
        status: changeResult.status,
        chunksCreated: chunks.length,
        graphIndexation: graphResult,
      };
    } catch (error: any) {
      pceLogger.error(`Failed to ingest file: ${filePath}`, { error: error.message });
      throw error;
    }
  }

}
