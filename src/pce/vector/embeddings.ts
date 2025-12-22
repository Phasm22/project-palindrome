/**
 * Vector Database - Embedding Model Integration
 * Task 3.2: Integrate embedding model and convert chunk text to vectors
 * Supports: OpenAI, Local (Ollama), and Mixed modes
 */

import OpenAI from "openai";
import { pceLogger } from "../utils/logger";

export type EmbeddingProvider = "openai" | "local" | "mixed";

const EMBEDDING_PROVIDER = (process.env.EMBEDDINGS_PROVIDER || "openai") as EmbeddingProvider;
const OPENAI_EMBEDDING_MODEL = process.env.PCE_EMBEDDING_MODEL || "text-embedding-3-small";
const LOCAL_EMBED_MODEL = process.env.LOCAL_EMBED_MODEL || "nomic-embed-text";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

// Dimension mapping
const DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "nomic-embed-text": 768,
  "bge-small-en-v1.5": 384,
  "bge-base-en-v1.5": 768,
  "bge-large-en-v1.5": 1024,
};

// Query embedding cache entry
interface EmbeddingCacheEntry {
  embedding: number[];
  timestamp: number;
}

// Cache TTL: 5 minutes for query embeddings
const EMBEDDING_CACHE_TTL = 5 * 60 * 1000;
const EMBEDDING_CACHE_MAX_SIZE = 500;

export class EmbeddingService {
  private openai: OpenAI | null = null;
  private provider: EmbeddingProvider;
  private openaiModel: string;
  private localModel: string;
  private ollamaBaseUrl: string;
  private dimension: number;
  
  // Query embedding cache - avoids re-embedding repeated queries
  private queryCache: Map<string, EmbeddingCacheEntry> = new Map();
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(
    provider?: EmbeddingProvider,
    openaiModel?: string,
    localModel?: string,
    ollamaBaseUrl?: string
  ) {
    this.provider = provider || EMBEDDING_PROVIDER;
    this.openaiModel = openaiModel || OPENAI_EMBEDDING_MODEL;
    this.localModel = localModel || LOCAL_EMBED_MODEL;
    this.ollamaBaseUrl = ollamaBaseUrl || OLLAMA_BASE_URL;
    
    // Determine dimension based on provider and model
    if (this.provider === "openai") {
      this.dimension = DIMENSIONS[this.openaiModel] || 1536;
    } else {
      this.dimension = DIMENSIONS[this.localModel] || 768;
    }

    pceLogger.info("EmbeddingService initialized", {
      provider: this.provider,
      openaiModel: this.openaiModel,
      localModel: this.localModel,
      dimension: this.dimension,
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
   * Convert text to embedding vector (with caching for queries)
   * @param text - Text to embed
   * @param useCache - Whether to use cache (default: true for queries, false for document ingestion)
   */
  async embed(text: string, useCache = true): Promise<number[]> {
    // Normalize text for cache key (lowercase, trim whitespace)
    const cacheKey = text.toLowerCase().trim();
    
    // Check cache first (for short query-like texts)
    if (useCache && text.length < 500) {
      const cached = this.queryCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < EMBEDDING_CACHE_TTL) {
        this.cacheHits++;
        pceLogger.debug("Embedding cache hit", { 
          textLength: text.length, 
          cacheHits: this.cacheHits, 
          cacheMisses: this.cacheMisses 
        });
        return cached.embedding;
      }
    }
    
    this.cacheMisses++;
    
    try {
      let embedding: number[];
      
      if (this.provider === "openai") {
        embedding = await this.embedOpenAI(text);
      } else if (this.provider === "local") {
        embedding = await this.embedLocal(text);
      } else {
        // Mixed: try local first, fallback to OpenAI
        try {
          embedding = await this.embedLocal(text);
        } catch (error: any) {
          pceLogger.warn("Local embedding failed, falling back to OpenAI", { error: error.message });
          embedding = await this.embedOpenAI(text);
        }
      }
      
      // Cache the embedding for short texts (queries)
      if (useCache && text.length < 500) {
        // Evict oldest entries if cache is full
        if (this.queryCache.size >= EMBEDDING_CACHE_MAX_SIZE) {
          const oldestKey = this.queryCache.keys().next().value;
          if (oldestKey) this.queryCache.delete(oldestKey);
        }
        this.queryCache.set(cacheKey, { embedding, timestamp: Date.now() });
      }
      
      return embedding;
    } catch (error: any) {
      pceLogger.error("Failed to generate embedding", { error: error.message, provider: this.provider });
      throw error;
    }
  }
  
  /**
   * Get cache statistics
   */
  getCacheStats(): { hits: number; misses: number; size: number; hitRate: string } {
    const total = this.cacheHits + this.cacheMisses;
    const hitRate = total > 0 ? ((this.cacheHits / total) * 100).toFixed(1) + "%" : "N/A";
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.queryCache.size,
      hitRate,
    };
  }

  private async embedOpenAI(text: string): Promise<number[]> {
    const client = this.getClient();
    const response = await client.embeddings.create({
      model: this.openaiModel,
      input: text,
    });

    const embedding = response.data[0]?.embedding;
    if (!embedding) {
      throw new Error("No embedding returned from OpenAI");
    }

    pceLogger.debug(`Generated OpenAI embedding (length: ${text.length})`, {
      embeddingDimension: embedding.length,
      model: this.openaiModel,
    });

    return embedding;
  }

  private async embedLocal(text: string): Promise<number[]> {
    const response = await fetch(`${this.ollamaBaseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.localModel,
        prompt: text,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const embedding = data.embedding;

    if (!embedding || !Array.isArray(embedding)) {
      throw new Error("Invalid embedding response from Ollama");
    }

    pceLogger.debug(`Generated local embedding (length: ${text.length})`, {
      embeddingDimension: embedding.length,
      model: this.localModel,
    });

    return embedding;
  }

  /**
   * Batch embed multiple texts
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    try {
      if (this.provider === "openai") {
        const client = this.getClient();
        const response = await client.embeddings.create({
          model: this.openaiModel,
          input: texts,
        });
        const embeddings = response.data.map((item) => item.embedding);
        pceLogger.debug(`Generated ${embeddings.length} OpenAI embeddings in batch`);
        return embeddings;
      } else {
        // Local or mixed: Ollama doesn't support batch, so do parallel
        const embeddings = await Promise.all(texts.map((text) => this.embed(text)));
        pceLogger.debug(`Generated ${embeddings.length} local embeddings in batch`);
        return embeddings;
      }
    } catch (error: any) {
      pceLogger.error("Failed to generate batch embeddings", { error: error.message, provider: this.provider });
      throw error;
    }
  }

  /**
   * Get embedding dimension for the current model
   */
  getDimension(): number {
    return this.dimension;
  }
}


