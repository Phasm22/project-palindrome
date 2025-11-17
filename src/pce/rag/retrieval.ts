/**
 * Core RAG & Orchestrator - Semantic Retrieval
 * Task 4.1: Simple Semantic Retrieval Path
 * Task 4.1.1: Retrieval Parameters Config
 * Task 4.3: Access Control Filter (V1)
 */

import type { RetrievalConfig, RetrievalResult, DocumentChunk, ACLGroup } from "../types";
import { QdrantVectorStore } from "../vector/qdrant-client";
import { EmbeddingService } from "../vector/embeddings";
import { pceLogger } from "../utils/logger";

const DEFAULT_CONFIG: RetrievalConfig = {
  topK: 5,
  maxTokens: 4096,
  similarityThreshold: 0.5, // Lowered from 0.7 to allow more matches for testing
};

export class RetrievalService {
  private vectorStore: QdrantVectorStore;
  private embeddingService: EmbeddingService;
  private config: RetrievalConfig;

  constructor(
    vectorStore: QdrantVectorStore,
    embeddingService: EmbeddingService,
    config: RetrievalConfig = DEFAULT_CONFIG
  ) {
    this.vectorStore = vectorStore;
    this.embeddingService = embeddingService;
    this.config = config;
  }

  /**
   * Update retrieval configuration
   */
  setConfig(config: Partial<RetrievalConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Task 4.1: Simple Semantic Retrieval Path
   * User Query -> Embed Query -> Vector Search (KNN) -> Retrieve Top N chunks
   * 
   * Task 4.3: Access Control Filter (V1)
   * Only return chunks where ACL_GROUP matches user's group
   */
  async retrieve(
    query: string,
    userACLGroup: ACLGroup,
    customConfig?: Partial<RetrievalConfig>
  ): Promise<RetrievalResult> {
    try {
      const config = { ...this.config, ...customConfig };
      
      pceLogger.info(`Retrieving chunks for query`, {
        queryLength: query.length,
        topK: config.topK,
        aclGroup: userACLGroup,
      });

      // Embed query
      const queryEmbedding = await this.embeddingService.embed(query);

      // Vector search with ACL filter
      const results = await this.vectorStore.search(
        queryEmbedding,
        config.topK,
        userACLGroup // Task 4.3: Access control filter
      );

      // Filter by similarity threshold if set
      // Note: Qdrant uses cosine similarity (0-1 range), higher is more similar
      const filteredResults = config.similarityThreshold !== undefined
        ? results.filter((r) => r.score >= config.similarityThreshold!)
        : results;
      
      pceLogger.debug("Search results", {
        totalResults: results.length,
        afterThresholdFilter: filteredResults.length,
        threshold: config.similarityThreshold,
        scores: results.map(r => r.score),
      });

      // Apply token budget (rough estimation: 1 token ≈ 4 characters)
      const chunks: DocumentChunk[] = [];
      let totalTokens = 0;

      for (const result of filteredResults) {
        const estimatedTokens = Math.ceil(result.chunk.text.length / 4);
        if (totalTokens + estimatedTokens > config.maxTokens) {
          pceLogger.warn("Token budget exceeded, stopping retrieval", {
            tokensUsed: totalTokens,
            maxTokens: config.maxTokens,
          });
          break;
        }

        chunks.push(result.chunk);
        totalTokens += estimatedTokens;
      }

      pceLogger.info(`Retrieved ${chunks.length} chunks`, {
        totalResults: filteredResults.length,
        tokensUsed: totalTokens,
      });

      return {
        chunks,
        scores: filteredResults.slice(0, chunks.length).map((r) => r.score),
        queryEmbedding,
      };
    } catch (error: any) {
      pceLogger.error("Failed to retrieve chunks", { error: error.message });
      throw error;
    }
  }
}

