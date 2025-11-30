/**
 * Local LLM Service (Ollama)
 * Alternative to OpenAI for LLM inference using local GPU-accelerated models
 */

import type { DocumentChunk, RAGResponse } from "../types";
import { pceLogger } from "../utils/logger";

export type LLMProvider = "openai" | "local" | "mixed";

const LLM_PROVIDER = (process.env.LLM_PROVIDER || "openai") as LLMProvider;
const LOCAL_LLM_MODEL = process.env.LOCAL_LLM_MODEL || "mistral:7b";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const DEFAULT_MAX_TOKENS = 1000;

export interface LocalLLMConfig {
  provider?: LLMProvider;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

export class LocalLLMService {
  private config: Required<LocalLLMConfig>;
  private provider: LLMProvider;

  constructor(config: LocalLLMConfig = {}) {
    this.provider = config.provider || LLM_PROVIDER;
    this.config = {
      provider: this.provider,
      model: config.model || LOCAL_LLM_MODEL,
      baseUrl: config.baseUrl || OLLAMA_BASE_URL,
      maxTokens: config.maxTokens || DEFAULT_MAX_TOKENS,
      temperature: config.temperature ?? 0.7,
    };

    pceLogger.info("LocalLLMService initialized", {
      provider: this.config.provider,
      model: this.config.model,
      baseUrl: this.config.baseUrl,
    });
  }

  /**
   * Generate completion using Ollama
   */
  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    try {
      const messages: Array<{ role: string; content: string }> = [];
      
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }
      messages.push({ role: "user", content: prompt });

      // Add timeout to prevent hanging requests
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout
      
      try {
        const response = await fetch(`${this.config.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.config.model,
            messages,
            options: {
              temperature: this.config.temperature,
              num_predict: this.config.maxTokens,
            },
            stream: false,
          }),
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Ollama API error: ${response.status} ${errorText}`);
        }

        const data = await response.json();
        const content = data.message?.content;

        if (!content) {
          throw new Error("No content in Ollama response");
        }

        pceLogger.debug("Generated local LLM response", {
          model: this.config.model,
          responseLength: content.length,
        });

        return content;
      } catch (fetchError: any) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          throw new Error("Ollama request timed out after 60 seconds");
        }
        throw fetchError;
      }
    } catch (error: any) {
      pceLogger.error("Failed to generate local LLM response", { error: error.message });
      throw error;
    }
  }

  /**
   * Generate RAG response (compatible with GenerationService interface)
   */
  async generateRAG(query: string, chunks: DocumentChunk[]): Promise<RAGResponse> {
    try {
      // Build context from chunks
      const context = chunks
        .map((chunk, index) => {
          return `[Source ${index + 1}: ${chunk.metadata.sourcePath}]\n${chunk.text}`;
        })
        .join("\n\n---\n\n");

      const systemPrompt = `You are a helpful assistant that answers questions based on the provided context. 
Always cite your sources using the [Source N] format when referencing information from the context.
If the context doesn't contain enough information to answer the question, say so clearly.`;

      const userPrompt = `Context:\n${context}\n\nQuestion: ${query}\n\nAnswer:`;

      const answer = await this.generate(userPrompt, systemPrompt);

      // Build sources with scores
      const sources = chunks.map((chunk, index) => ({
        chunkId: chunk.id,
        sourcePath: chunk.metadata.sourcePath,
        score: 1.0,
        text: chunk.text.slice(0, 200) + (chunk.text.length > 200 ? "..." : ""),
      }));

      pceLogger.info("Generated local RAG response", {
        answerLength: answer.length,
        chunksUsed: chunks.length,
        model: this.config.model,
      });

      return {
        answer,
        sources,
        metadata: {
          tokensUsed: 0, // Ollama doesn't provide token counts in response
          chunksRetrieved: chunks.length,
        },
      };
    } catch (error: any) {
      pceLogger.error("Failed to generate local RAG response", { error: error.message });
      throw error;
    }
  }

  /**
   * Check if Ollama service is available
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        method: "GET",
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

