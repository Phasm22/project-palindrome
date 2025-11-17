/**
 * Vector Database - Qdrant Client
 * Task 3.1: Vector DB Installation & Service Setup
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import type { DocumentChunk, VectorDocument } from "../types";
import type { QdrantPayload } from "./schema";
import { metadataToPayload, payloadToMetadata } from "./schema";
import { pceLogger } from "../utils/logger";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION_NAME = process.env.PCE_COLLECTION_NAME || "pce_documents";

export class QdrantVectorStore {
  private client: QdrantClient;
  private collectionName: string;

  constructor(url: string = QDRANT_URL, apiKey?: string, collectionName: string = COLLECTION_NAME) {
    this.client = new QdrantClient({
      url,
      apiKey,
    });
    this.collectionName = collectionName;
  }

  /**
   * Initialize collection with schema
   * Task 3.1: Create collection using defined schema
   */
  async initializeCollection(vectorSize: number = 1536): Promise<void> {
    try {
      // Check if collection exists
      const collections = await this.client.getCollections();
      const exists = collections.collections.some((c: any) => c.name === this.collectionName);

      if (exists) {
        pceLogger.info(`Collection '${this.collectionName}' already exists`);
        return;
      }

      // Create collection
      await this.client.createCollection(this.collectionName, {
        vectors: {
          size: vectorSize,
          distance: "Cosine",
        },
      });

      pceLogger.info(`Created collection '${this.collectionName}' with vector size ${vectorSize}`);
    } catch (error: any) {
      pceLogger.error("Failed to initialize collection", { error: error.message });
      throw error;
    }
  }

  /**
   * Index a document chunk
   * Task 3.3: Indexation Module (Write Path)
   */
  async indexChunk(chunk: DocumentChunk, vector: number[]): Promise<void> {
    try {
      const payload: QdrantPayload = metadataToPayload(chunk.metadata, chunk.text);

      await this.client.upsert(this.collectionName, {
        wait: true,
        points: [
          {
            id: chunk.id,
            vector,
            payload: payload as any,
          },
        ],
      });

      pceLogger.debug(`Indexed chunk: ${chunk.id}`, {
        sourcePath: chunk.metadata.sourcePath,
        chunkIndex: chunk.metadata.chunkIndex,
      });
    } catch (error: any) {
      pceLogger.error(`Failed to index chunk: ${chunk.id}`, { error: error.message });
      throw error;
    }
  }

  /**
   * Batch index multiple chunks
   */
  async indexChunks(chunks: DocumentChunk[], vectors: number[][]): Promise<void> {
    if (chunks.length !== vectors.length) {
      throw new Error("Chunks and vectors arrays must have the same length");
    }

    try {
      const points = chunks.map((chunk, index) => {
        const payload: QdrantPayload = metadataToPayload(chunk.metadata, chunk.text);
        return {
          id: chunk.id,
          vector: vectors[index],
          payload: payload as any,
        };
      });

      await this.client.upsert(this.collectionName, {
        wait: true,
        points,
      });

      pceLogger.info(`Indexed ${chunks.length} chunks in batch`);
    } catch (error: any) {
      pceLogger.error("Failed to batch index chunks", { error: error.message });
      throw error;
    }
  }

  /**
   * Search for similar chunks
   * Returns top K results with scores
   */
  async search(
    queryVector: number[],
    topK: number,
    aclGroup?: string,
    filter?: Record<string, any>
  ): Promise<Array<{ chunk: DocumentChunk; score: number }>> {
    try {
      // Build filter
      const searchFilter: any = {};
      if (aclGroup) {
        searchFilter.must = [
          {
            key: "acl_group",
            match: { value: aclGroup },
          },
        ];
      }
      if (filter) {
        if (!searchFilter.must) searchFilter.must = [];
        searchFilter.must.push(...Object.entries(filter).map(([key, value]) => ({
          key,
          match: { value },
        })));
      }

      const searchParams: any = {
        vector: queryVector,
        limit: topK,
        with_payload: true,
      };

      if (Object.keys(searchFilter).length > 0) {
        searchParams.filter = searchFilter;
      }

      const results = await this.client.search(this.collectionName, searchParams);

      const chunks: Array<{ chunk: DocumentChunk; score: number }> = results.map((result: any) => {
        const payload = result.payload as any as QdrantPayload;
        const metadata = payloadToMetadata(payload);

        return {
          chunk: {
            id: result.id as string,
            text: payload.text,
            metadata,
            startIndex: 0, // Not stored in vector DB
            endIndex: payload.text.length,
          },
          score: result.score || 0,
        };
      });

      pceLogger.debug(`Search returned ${chunks.length} results`, {
        topK,
        aclGroup,
      });

      return chunks;
    } catch (error: any) {
      pceLogger.error("Failed to search vector store", { error: error.message });
      throw error;
    }
  }

  /**
   * Delete chunks by version hash (for re-indexing)
   */
  async deleteByVersionHash(versionHash: string): Promise<void> {
    try {
      await this.client.delete(this.collectionName, {
        wait: true,
        filter: {
          must: [
            {
              key: "version_hash",
              match: { value: versionHash },
            },
          ],
        },
      });

      pceLogger.info(`Deleted chunks with version hash: ${versionHash}`);
    } catch (error: any) {
      pceLogger.error("Failed to delete chunks by version hash", { error: error.message });
      throw error;
    }
  }

  /**
   * Get collection info
   */
  async getCollectionInfo(): Promise<any> {
    try {
      return await this.client.getCollection(this.collectionName);
    } catch (error: any) {
      pceLogger.error("Failed to get collection info", { error: error.message });
      throw error;
    }
  }
}

