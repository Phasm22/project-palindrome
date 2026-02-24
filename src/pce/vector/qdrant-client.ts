/**
 * Vector Database - Qdrant Client
 * Task 3.1: Vector DB Installation & Service Setup
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import type { DocumentChunk, VectorDocument } from "../types";
import type { QdrantPayload } from "./schema";
import { metadataToPayload, payloadToMetadata } from "./schema";
import { pceLogger } from "../utils/logger";
import { DEFAULT_COLLECTION } from "./collection-names";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;

export class QdrantVectorStore {
  private client: QdrantClient;
  private collectionName: string;
  private vectorDimension: number = 1536; // Default, will be set by initializeCollection

  constructor(url: string = QDRANT_URL, apiKey?: string, collectionName: string = DEFAULT_COLLECTION) {
    this.client = new QdrantClient({
      url,
      apiKey,
    });
    this.collectionName = collectionName;
  }

  /**
   * Initialize collection with schema
   * Task 3.1: Create collection using defined schema
   * If collection exists with wrong dimension, it will be recreated
   */
  async initializeCollection(vectorSize: number = 1536): Promise<void> {
    try {
      this.vectorDimension = vectorSize;
      
      // Check if collection exists
      const collections = await this.client.getCollections();
      const existing = collections.collections.find((c: any) => c.name === this.collectionName);

      if (existing) {
        // Check if the existing collection has the correct dimension
        const collectionInfo = await this.client.getCollection(this.collectionName);
        const existingSize = collectionInfo.config?.params?.vectors?.size;
        
        if (existingSize === vectorSize) {
          pceLogger.info(`Collection '${this.collectionName}' already exists with correct dimension ${vectorSize}`);
        return;
        } else {
          pceLogger.warn(
            `Collection '${this.collectionName}' exists with dimension ${existingSize}, but expected ${vectorSize}. ` +
            `Recreating collection...`
          );
          // Delete existing collection
          await this.client.deleteCollection(this.collectionName);
          pceLogger.info(`Deleted existing collection '${this.collectionName}'`);
        }
      }

      // Create collection with correct dimension
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
      // Store original chunk ID in payload for retrieval
      const payload: QdrantPayload = metadataToPayload(chunk.metadata, chunk.text, chunk.id);
      
      // Validate vector dimension
      if (!vector || vector.length !== this.vectorDimension) {
        throw new Error(`Invalid vector dimension for chunk ${chunk.id}: expected ${this.vectorDimension}, got ${vector?.length || 0}`);
      }
      
      // Ensure all payload fields are defined
      const cleanPayload: any = {
        text: payload.text || "",
        version_hash: payload.version_hash || "",
        acl_group: payload.acl_group || "",
        source_type: payload.source_type || "",
        source_path: payload.source_path || "",
        timestamp: payload.timestamp || new Date().toISOString(),
        chunk_index: payload.chunk_index ?? 0,
        total_chunks: payload.total_chunks ?? 0,
        chunk_id: payload.chunk_id || chunk.id,
      };

      // Qdrant only accepts unsigned integers or UUIDs - convert string ID to integer
      const pointId = this.stringIdToInt(chunk.id);

      await this.client.upsert(this.collectionName, {
        wait: true,
        points: [
          {
            id: pointId,
            vector,
            payload: cleanPayload,
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
   * Convert string ID to integer hash for Qdrant compatibility
   * Qdrant only accepts unsigned integers or UUIDs as point IDs
   */
  private stringIdToInt(id: string): number {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      const char = id.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    // Ensure positive integer (Qdrant requires unsigned)
    return Math.abs(hash) >>> 0; // >>> 0 converts to unsigned 32-bit integer
  }

  /**
   * Batch index multiple chunks
   * Task 14.2: Vector DB Batch Update Optimization
   * Uses native batch/upsert functionality to minimize network calls
   */
  async indexChunks(
    chunks: DocumentChunk[],
    vectors: number[][],
    batchSize: number = 100
  ): Promise<void> {
    if (chunks.length !== vectors.length) {
      throw new Error("Chunks and vectors arrays must have the same length");
    }

    // Process in batches to avoid overwhelming the API
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batchChunks = chunks.slice(i, i + batchSize);
      const batchVectors = vectors.slice(i, i + batchSize);

      let points: any[] = [];
      try {
        points = batchChunks.map((chunk, index) => {
          // Store original chunk ID in payload for retrieval
          const payload: QdrantPayload = metadataToPayload(chunk.metadata, chunk.text, chunk.id);
          
          // Validate vector dimension
          if (!batchVectors[index] || batchVectors[index].length !== this.vectorDimension) {
            throw new Error(`Invalid vector dimension for chunk ${chunk.id}: expected ${this.vectorDimension}, got ${batchVectors[index]?.length || 0}`);
          }
          
          // Ensure all payload fields are defined
          const cleanPayload: any = {
            text: payload.text || "",
            version_hash: payload.version_hash || "",
            acl_group: payload.acl_group || "",
            source_type: payload.source_type || "",
            source_path: payload.source_path || "",
            timestamp: payload.timestamp || new Date().toISOString(),
            chunk_index: payload.chunk_index ?? 0,
            total_chunks: payload.total_chunks ?? 0,
            chunk_id: payload.chunk_id || chunk.id,
          };
          
          // Qdrant only accepts unsigned integers or UUIDs - convert string ID to integer
          const pointId = this.stringIdToInt(chunk.id);
          
          return {
            id: pointId,
            vector: batchVectors[index],
            payload: cleanPayload,
          };
        });

        // Use native batch upsert - single network call for entire batch
        await this.client.upsert(this.collectionName, {
          wait: true,
          points,
        });

        pceLogger.debug(`Indexed batch of ${batchChunks.length} chunks`, {
          batchIndex: Math.floor(i / batchSize) + 1,
          totalBatches: Math.ceil(chunks.length / batchSize),
        });
      } catch (error: any) {
        pceLogger.error("Failed to batch index chunks", { 
          error: error.message,
          errorDetails: error.data || error.status || error,
          pointsCount: points.length,
          batchIndex: Math.floor(i / batchSize) + 1,
        });
        throw error;
      }
    }

    pceLogger.info(`Indexed ${chunks.length} chunks in ${Math.ceil(chunks.length / batchSize)} batch(es)`);
  }

  /**
   * Task 12.3: Fast-Path Index Update Logic
   * Incrementally update only modified chunks (by comparing chunk hashes)
   */
  async updateChunksIncremental(
    chunks: DocumentChunk[],
    vectors: number[][],
    versionHash: string
  ): Promise<{ updated: number; skipped: number }> {
    if (chunks.length !== vectors.length) {
      throw new Error("Chunks and vectors arrays must have the same length");
    }

    // Get existing chunks for this version hash
    const existingChunks = await this.getChunksByVersionHash(versionHash);
    const existingChunkMap = new Map(
      existingChunks.map((c) => [c.chunk.id, c])
    );

    // Identify which chunks need updating
    const chunksToUpdate: Array<{ chunk: DocumentChunk; vector: number[]; index: number }> = [];
    let skipped = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const vector = vectors[i];
      if (!chunk || !vector) {
        skipped++;
        continue;
      }
      const existing = existingChunkMap.get(chunk.id);

      // Update if chunk doesn't exist or if content changed (compare hash)
      if (!existing) {
        chunksToUpdate.push({ chunk, vector, index: i });
      } else {
        // Compare chunk content hash to detect changes
        const existingText = existing.chunk.text;
        const newText = chunk.text;
        
        // Simple comparison - in production, could use chunk hash from metadata
        if (existingText !== newText) {
          chunksToUpdate.push({ chunk, vector, index: i });
        } else {
          skipped++;
        }
      }
    }

    if (chunksToUpdate.length === 0) {
      pceLogger.info(`No chunks need updating (all unchanged)`, {
        totalChunks: chunks.length,
        skipped,
      });
      return { updated: 0, skipped };
    }

    // Batch update only modified chunks
    const updateChunks = chunksToUpdate.map((u) => u.chunk);
    const updateVectors = chunksToUpdate.map((u) => u.vector);
    
    await this.indexChunks(updateChunks, updateVectors);

    pceLogger.info(`Incremental update completed`, {
      updated: chunksToUpdate.length,
      skipped,
      totalChunks: chunks.length,
    });

    return { updated: chunksToUpdate.length, skipped };
  }

  /**
   * Get chunks by version hash (for incremental update comparison)
   */
  private async getChunksByVersionHash(versionHash: string): Promise<Array<{ chunk: DocumentChunk; score: number }>> {
    try {
      // Search with filter to get all chunks for this version
      const results = await this.client.scroll(this.collectionName, {
        filter: {
          must: [
            {
              key: "version_hash",
              match: { value: versionHash },
            },
          ],
        },
        limit: 10000, // Adjust based on expected chunk count
        with_payload: true,
        with_vector: false,
      });

      return (results.points || []).map((point: any) => {
        const payload = point.payload as any as QdrantPayload;
        const metadata = payloadToMetadata(payload);
        const chunkId = (payload as any).chunk_id || point.id?.toString() || String(point.id);

        return {
          chunk: {
            id: chunkId,
            text: payload.text,
            metadata,
            startIndex: 0,
            endIndex: payload.text.length,
          },
          score: 1.0, // Not relevant for retrieval, just for structure
        };
      });
    } catch (error: any) {
      pceLogger.error("Failed to get chunks by version hash", { error: error.message });
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
      // Build filter - Qdrant filter format
      // Admin group bypasses ACL filtering (can see all chunks)
      let searchFilter: any = null;
      if ((aclGroup && aclGroup !== "admin") || filter) {
        const mustConditions: any[] = [];
        
        // Only apply ACL filter if not admin
        if (aclGroup && aclGroup !== "admin") {
          mustConditions.push({
            key: "acl_group",
            match: { value: aclGroup },
          });
        }
        
        if (filter) {
          mustConditions.push(...Object.entries(filter).map(([key, value]) => ({
            key,
            match: { value },
          })));
        }
        
        if (mustConditions.length > 0) {
          searchFilter = {
            must: mustConditions,
          };
        }
      }

      const searchParams: any = {
        vector: queryVector,
        limit: topK,
        with_payload: true,
      };

      if (searchFilter) {
        searchParams.filter = searchFilter;
      }
      
      pceLogger.info("Qdrant search params", {
        hasFilter: !!searchFilter,
        filter: JSON.stringify(searchFilter),
        limit: topK,
        aclGroup: aclGroup || "none",
      });

      const results = await this.client.search(this.collectionName, searchParams);
      
      // Debug: Log sample payloads to verify structure
      if (results.length > 0) {
        const samplePayload = (results[0] as any)?.payload;
        pceLogger.info("Qdrant search sample payload", {
          acl_group: samplePayload?.acl_group,
          acl_group_type: typeof samplePayload?.acl_group,
          allKeys: Object.keys(samplePayload || {}),
        });
      } else if (aclGroup && aclGroup !== "admin") {
        // If no results with filter, try without filter to see what's there
        pceLogger.warn("Qdrant search returned 0 results with filter", {
          aclGroup,
          filter: JSON.stringify(searchFilter),
        });
      }
      
      pceLogger.info("Qdrant search results", {
        resultCount: results.length,
        scores: results.map((r: any) => r.score),
      });

      const chunks: Array<{ chunk: DocumentChunk; score: number }> = results.map((result: any) => {
        const payload = result.payload as any as QdrantPayload;
        const metadata = payloadToMetadata(payload);
        // If we stored the original chunk ID in payload, use it; otherwise use the result ID
        const chunkId = (payload as any).chunk_id || result.id?.toString() || String(result.id);

        return {
          chunk: {
            id: chunkId,
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

  async probeAccessGroups(queryVector: number[], topK: number = 5): Promise<(string | null)[]> {
    try {
      const results = await this.client.search(this.collectionName, {
        vector: queryVector,
        limit: topK,
        with_payload: {
          include: ["acl_group"],
        },
      });

      return results.map((result: any) => {
        const payload = result.payload as QdrantPayload;
        return (payload as any)?.acl_group ?? null;
      });
    } catch (error: any) {
      pceLogger.warn("ACL probe failed", { error: error.message });
      return [];
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
   * Clear all points from collection (for test isolation)
   * Deletes and recreates the collection
   */
  async clearCollection(): Promise<void> {
    try {
      const collections = await this.client.getCollections();
      const existing = collections.collections.find((c: any) => c.name === this.collectionName);
      
      if (existing) {
        await this.client.deleteCollection(this.collectionName);
        pceLogger.info(`Cleared collection '${this.collectionName}' for test isolation`);
      }
      
      // Recreate collection with same dimension
      await this.initializeCollection(this.vectorDimension);
    } catch (error: any) {
      pceLogger.error("Failed to clear collection", { error: error.message });
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

  /**
   * Get collection name (for external access)
   */
  getCollectionName(): string {
    return this.collectionName;
  }

  /**
   * Get Qdrant client (for external access to scroll/query methods)
   */
  getClient(): QdrantClient {
    return this.client;
  }

  /**
   * Simple health check to verify Qdrant connectivity
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.getCollections();
      return true;
    } catch (error: any) {
      pceLogger.warn("Qdrant health check failed", { error: error.message });
      return false;
    }
  }
}
