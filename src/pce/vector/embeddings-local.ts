/**
 * Local Embedding Service (GPU-accelerated)
 * Alternative to OpenAI embeddings using local models
 */

import { pceLogger } from "../utils/logger";

// Using sentence-transformers via @xenova/transformers (runs in Bun/Node)
// Or use Ollama API for embeddings

export interface LocalEmbeddingConfig {
  provider: "ollama" | "sentence-transformers" | "custom";
  model?: string;
  dimension?: number;
  baseUrl?: string;
}

const DEFAULT_CONFIG: LocalEmbeddingConfig = {
  provider: "ollama",
  model: "bge-small-en-v1.5", // 384 dimensions
  dimension: 384,
  baseUrl: "http://localhost:11434",
};

interface OllamaEmbeddingResponse {
  embedding?: number[];
}

export class LocalEmbeddingService {
  private config: LocalEmbeddingConfig;
  private dimension: number;

  constructor(config: Partial<LocalEmbeddingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dimension = this.config.dimension || 384;
  }

  /**
   * Convert text to embedding vector using Ollama
   */
  async embed(text: string): Promise<number[]> {
    if (this.config.provider === "ollama") {
      return this.embedOllama(text);
    }
    throw new Error(`Unsupported provider: ${this.config.provider}`);
  }

  private async embedOllama(text: string): Promise<number[]> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          prompt: text,
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.statusText}`);
      }

      const data = (await response.json()) as OllamaEmbeddingResponse;
      const embedding = data.embedding;

      if (!embedding || !Array.isArray(embedding)) {
        throw new Error("Invalid embedding response from Ollama");
      }

      pceLogger.debug(`Generated local embedding (length: ${text.length})`, {
        embeddingDimension: embedding.length,
        provider: "ollama",
      });

      return embedding;
    } catch (error: any) {
      pceLogger.error("Failed to generate local embedding", { error: error.message });
      throw error;
    }
  }

  /**
   * Batch embed multiple texts
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    // Ollama doesn't support batch, so do sequential (or parallel)
    const embeddings = await Promise.all(texts.map((text) => this.embed(text)));
    
    pceLogger.debug(`Generated ${embeddings.length} local embeddings in batch`);
    return embeddings;
  }

  /**
   * Get embedding dimension
   */
  getDimension(): number {
    return this.dimension;
  }
}
