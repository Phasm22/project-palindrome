/**
 * LLM Result Cache
 * Task 14.1.1: LLM Fallback Worker (Cache-Based)
 * Cache embeddings and entity extraction results for fallback on failure
 */

import { createHash } from "crypto";
import { pceLogger } from "../utils/logger";

export interface CachedResult<T> {
  value: T;
  timestamp: Date;
  expiresAt: Date;
  hits: number;
}

export interface LLMCacheOptions {
  ttlSeconds?: number; // Time to live in seconds
  maxSize?: number; // Maximum cache size
}

/**
 * LLM Result Cache with TTL and size limits
 */
export class LLMCache<T> {
  private cache: Map<string, CachedResult<T>> = new Map();
  private options: Required<LLMCacheOptions>;

  constructor(options: LLMCacheOptions = {}) {
    this.options = {
      ttlSeconds: options.ttlSeconds || 86400, // 24 hours default
      maxSize: options.maxSize || 10000,
    };

    // Start cleanup interval
    setInterval(() => this.cleanup(), 60000); // Clean every minute
  }

  /**
   * Generate cache key from input
   */
  private generateKey(input: string, type: string): string {
    const hash = createHash("sha256");
    hash.update(`${type}:${input}`, "utf8");
    return hash.digest("hex");
  }

  /**
   * Get cached result
   */
  get(input: string, type: string): T | null {
    const key = this.generateKey(input, type);
    const cached = this.cache.get(key);

    if (!cached) {
      return null;
    }

    // Check if expired
    if (new Date() > cached.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Update hit count
    cached.hits++;
    pceLogger.debug(`Cache hit`, {
      key,
      type,
      hits: cached.hits,
    });

    return cached.value;
  }

  /**
   * Set cached result
   */
  set(input: string, type: string, value: T): void {
    const key = this.generateKey(input, type);

    // Evict if at max size
    if (this.cache.size >= this.options.maxSize && !this.cache.has(key)) {
      this.evictOldest();
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.options.ttlSeconds * 1000);

    this.cache.set(key, {
      value,
      timestamp: now,
      expiresAt,
      hits: 0,
    });

    pceLogger.debug(`Cache set`, {
      key,
      type,
      cacheSize: this.cache.size,
    });
  }

  /**
   * Evict oldest entry (LRU-like, but simpler)
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();

    for (const [key, value] of this.cache.entries()) {
      if (value.timestamp.getTime() < oldestTime) {
        oldestTime = value.timestamp.getTime();
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      pceLogger.debug(`Cache evicted oldest entry`, { key: oldestKey });
    }
  }

  /**
   * Cleanup expired entries
   */
  private cleanup(): void {
    const now = new Date();
    let cleaned = 0;

    for (const [key, value] of this.cache.entries()) {
      if (now > value.expiresAt) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      pceLogger.debug(`Cache cleanup`, {
        cleaned,
        remaining: this.cache.size,
      });
    }
  }

  /**
   * Clear all cache
   */
  clear(): void {
    this.cache.clear();
    pceLogger.info("Cache cleared");
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    maxSize: number;
    totalHits: number;
    hitRate: number;
  } {
    let totalHits = 0;
    for (const value of this.cache.values()) {
      totalHits += value.hits;
    }

    return {
      size: this.cache.size,
      maxSize: this.options.maxSize,
      totalHits,
      hitRate: this.cache.size > 0 ? totalHits / this.cache.size : 0,
    };
  }
}

