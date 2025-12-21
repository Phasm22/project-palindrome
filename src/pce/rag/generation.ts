/**
 * Core RAG & Orchestrator - Generation Layer
 * Task 4.2: Generation Layer Integration
 * Supports: OpenAI, Local (Ollama), and Mixed modes
 */

import OpenAI from "openai";
import type { DocumentChunk, RAGResponse } from "../types";
import { pceLogger } from "../utils/logger";
import { LocalLLMService, type LLMProvider } from "../llm/local-llm-service";

const LLM_PROVIDER = (process.env.LLM_PROVIDER || "openai") as LLMProvider;
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_TOKENS = 1000;

export class GenerationService {
  private openai: OpenAI | null = null;
  private localLLM: LocalLLMService | null = null;
  private provider: LLMProvider;
  private openaiModel: string;
  private maxTokens: number;

  constructor(
    provider?: LLMProvider,
    model?: string,
    maxTokens: number = DEFAULT_MAX_TOKENS
  ) {
    this.provider = provider || LLM_PROVIDER;
    this.openaiModel = model || DEFAULT_MODEL;
    this.maxTokens = maxTokens;

    if (this.provider === "local" || this.provider === "mixed") {
      this.localLLM = new LocalLLMService({
        provider: this.provider,
        maxTokens: this.maxTokens,
      });
    }

    pceLogger.info("GenerationService initialized", {
      provider: this.provider,
      openaiModel: this.openaiModel,
    });
  }

  private getClient(): OpenAI {
    if (!this.openai) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY environment variable is not set");
      }
      this.openai = new OpenAI({ apiKey });
    }
    return this.openai;
  }

  /**
   * Task 4.2: Generate answer from query and retrieved chunks
   * Returns answer with source provenance
   */
  async generate(
    query: string,
    chunks: DocumentChunk[]
  ): Promise<RAGResponse> {
    try {
      if (this.provider === "openai") {
        return await this.generateOpenAI(query, chunks);
      } else if (this.provider === "local") {
        if (!this.localLLM) {
          throw new Error("LocalLLM not initialized");
        }
        return await this.localLLM.generateRAG(query, chunks);
      } else {
        // Mixed: try local first, fallback to OpenAI
        try {
          if (!this.localLLM) {
            throw new Error("LocalLLM not initialized");
          }
          return await this.localLLM.generateRAG(query, chunks);
        } catch (error: any) {
          pceLogger.warn("Local LLM failed, falling back to OpenAI", { error: error.message });
          return await this.generateOpenAI(query, chunks);
        }
      }
    } catch (error: any) {
      pceLogger.error("Failed to generate RAG response", { error: error.message, provider: this.provider });
      throw error;
    }
  }

  private async generateOpenAI(
    query: string,
    chunks: DocumentChunk[]
  ): Promise<RAGResponse> {
    try {
      const client = this.getClient();

      // Build context from chunks
      const context = chunks
        .map((chunk, index) => {
          return `[Source ${index + 1}: ${chunk.metadata.sourcePath}]\n${chunk.text}`;
        })
        .join("\n\n---\n\n");

      const systemPrompt = `You are a helpful assistant that answers questions based on the provided context. 
Provide direct, concise answers. Do not include source citations like "[Source N]" in your answer.
Focus on the actual information requested. If the context doesn't contain enough information, say so clearly.`;

      const userPrompt = `Context:\n${context}\n\nQuestion: ${query}\n\nAnswer:`;

      const response = await client.chat.completions.create({
        model: this.openaiModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: this.maxTokens,
        temperature: 0.7,
      });

      const answer = response.choices[0]?.message?.content || "No response generated.";

      // Build sources with scores (if available)
      const sources = chunks.map((chunk, index) => ({
        chunkId: chunk.id,
        sourcePath: chunk.metadata.sourcePath,
        score: 1.0, // Score would come from retrieval if available
        text: chunk.text.slice(0, 200) + (chunk.text.length > 200 ? "..." : ""),
      }));

      // Estimate tokens used
      const tokensUsed = response.usage?.total_tokens || 0;

      pceLogger.info("Generated OpenAI RAG response", {
        answerLength: answer.length,
        chunksUsed: chunks.length,
        tokensUsed,
        model: this.openaiModel,
      });

      return {
        answer,
        sources,
        metadata: {
          tokensUsed,
          chunksRetrieved: chunks.length,
        },
      };
    } catch (error: any) {
      pceLogger.error("Failed to generate OpenAI RAG response", { error: error.message });
      throw error;
    }
  }
}

