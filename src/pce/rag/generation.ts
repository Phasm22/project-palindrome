/**
 * Core RAG & Orchestrator - Generation Layer
 * Task 4.2: Generation Layer Integration
 */

import OpenAI from "openai";
import type { DocumentChunk, RAGResponse } from "../types";
import { pceLogger } from "../utils/logger";

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_TOKENS = 1000;

export class GenerationService {
  private openai: OpenAI | null = null;
  private model: string;
  private maxTokens: number;

  constructor(model: string = DEFAULT_MODEL, maxTokens: number = DEFAULT_MAX_TOKENS) {
    this.model = model;
    this.maxTokens = maxTokens;
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
      const client = this.getClient();

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

      const response = await client.chat.completions.create({
        model: this.model,
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

      pceLogger.info("Generated RAG response", {
        answerLength: answer.length,
        chunksUsed: chunks.length,
        tokensUsed,
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
      pceLogger.error("Failed to generate RAG response", { error: error.message });
      throw error;
    }
  }
}

