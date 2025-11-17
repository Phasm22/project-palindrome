/**
 * Vector Database - Embedding Model Integration
 * Task 3.2: Integrate embedding model and convert chunk text to vectors
 */

import OpenAI from "openai";
import { pceLogger } from "../utils/logger";

const EMBEDDING_MODEL = process.env.PCE_EMBEDDING_MODEL || "text-embedding-3-small";
const EMBEDDING_DIMENSION = 1536; // text-embedding-3-small dimension

export class EmbeddingService {
  private openai: OpenAI | null = null;
  private model: string;

  constructor(model: string = EMBEDDING_MODEL) {
    this.model = model;
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
   * Convert text to embedding vector
   */
  async embed(text: string): Promise<number[]> {
    try {
      const client = this.getClient();
      const response = await client.embeddings.create({
        model: this.model,
        input: text,
      });

      const embedding = response.data[0]?.embedding;
      if (!embedding) {
        throw new Error("No embedding returned from OpenAI");
      }

      pceLogger.debug(`Generated embedding for text (length: ${text.length})`, {
        embeddingDimension: embedding.length,
      });

      return embedding;
    } catch (error: any) {
      pceLogger.error("Failed to generate embedding", { error: error.message });
      throw error;
    }
  }

  /**
   * Batch embed multiple texts
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    try {
      const client = this.getClient();
      const response = await client.embeddings.create({
        model: this.model,
        input: texts,
      });

      const embeddings = response.data.map((item) => item.embedding);
      
      pceLogger.debug(`Generated ${embeddings.length} embeddings in batch`);
      
      return embeddings;
    } catch (error: any) {
      pceLogger.error("Failed to generate batch embeddings", { error: error.message });
      throw error;
    }
  }

  /**
   * Get embedding dimension for the current model
   */
  getDimension(): number {
    return EMBEDDING_DIMENSION;
  }
}

