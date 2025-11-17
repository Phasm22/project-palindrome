/**
 * Core RAG & Orchestrator - Main Orchestrator
 * Combines retrieval and generation
 */

import type { ACLGroup, RAGResponse, RetrievalConfig } from "../types";
import { RetrievalService } from "./retrieval";
import { GenerationService } from "./generation";
import { pceLogger } from "../utils/logger";

export class RAGOrchestrator {
  private retrievalService: RetrievalService;
  private generationService: GenerationService;

  constructor(retrievalService: RetrievalService, generationService: GenerationService) {
    this.retrievalService = retrievalService;
    this.generationService = generationService;
  }

  /**
   * Complete RAG pipeline: retrieve + generate
   */
  async query(
    userQuery: string,
    userACLGroup: ACLGroup,
    retrievalConfig?: Partial<RetrievalConfig>
  ): Promise<RAGResponse> {
    try {
      pceLogger.info("Starting RAG query", {
        query: userQuery.slice(0, 100),
        aclGroup: userACLGroup,
      });

      // Retrieve relevant chunks
      const retrievalResult = await this.retrievalService.retrieve(
        userQuery,
        userACLGroup,
        retrievalConfig
      );

      if (retrievalResult.chunks.length === 0) {
        pceLogger.warn("No chunks retrieved for query");
        return {
          answer: "I couldn't find any relevant information to answer your question.",
          sources: [],
          metadata: {
            tokensUsed: 0,
            chunksRetrieved: 0,
          },
        };
      }

      // Generate answer
      const response = await this.generationService.generate(userQuery, retrievalResult.chunks);

      // Update scores in sources
      response.sources = response.sources.map((source, index) => ({
        ...source,
        score: retrievalResult.scores[index] || 0,
      }));

      return response;
    } catch (error: any) {
      pceLogger.error("RAG query failed", { error: error.message });
      throw error;
    }
  }
}

