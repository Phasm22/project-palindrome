/**
 * Entity Disambiguation Layer - Alias Mapper
 * Task 6.4: Levenshtein & Alias Mapper Implementation
 * Task 6.5: EDL Logging & Ambiguity Tracking
 */

import { normalizeEntityText } from "./normalizer";
import { pceLogger } from "../../utils/logger";

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = Array.from(
    { length: len1 + 1 },
    () => Array<number>(len2 + 1).fill(0)
  );

  // Initialize matrix
  for (let i = 0; i <= len1; i++) {
    matrix[i]![0] = i;
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0]![j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= len1; i++) {
    const currentRow = matrix[i]!;
    const previousRow = matrix[i - 1]!;
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      currentRow[j] = Math.min(
        previousRow[j]! + 1, // deletion
        currentRow[j - 1]! + 1, // insertion
        previousRow[j - 1]! + cost // substitution
      );
    }
  }

  return matrix[len1]![len2]!;
}

/**
 * Calculate similarity score (0-1) using Levenshtein distance
 */
function calculateSimilarity(str1: string, str2: string): number {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1.0;

  const distance = levenshteinDistance(str1, str2);
  return 1 - distance / maxLen;
}

export interface AliasMatch {
  canonicalId: string;
  similarity: number;
  isAlias: boolean;
  ambiguous: boolean; // Score between 0.70-0.85
}

/**
 * Alias Mapper - Maps candidate entities to canonical entities
 */
export class AliasMapper {
  private canonicalEntities: Map<string, { normalizedText: string; aliases: string[] }> = new Map();
  private similarityThreshold: number;
  private ambiguousThreshold: { min: number; max: number };

  constructor(
    similarityThreshold: number = 0.85,
    ambiguousThreshold: { min: number; max: number } = { min: 0.70, max: 0.85 }
  ) {
    this.similarityThreshold = similarityThreshold;
    this.ambiguousThreshold = ambiguousThreshold;
  }

  /**
   * Register a canonical entity
   */
  registerCanonical(canonicalId: string, normalizedText: string, originalText?: string): void {
    if (!this.canonicalEntities.has(canonicalId)) {
      this.canonicalEntities.set(canonicalId, {
        normalizedText,
        aliases: originalText ? [originalText] : [],
      });
    } else {
      const entity = this.canonicalEntities.get(canonicalId)!;
      if (originalText && !entity.aliases.includes(originalText)) {
        entity.aliases.push(originalText);
      }
    }
  }

  /**
   * Find alias match for candidate entity
   */
  findAlias(candidateText: string, candidateType: string): AliasMatch | null {
    const normalizedCandidate = normalizeEntityText(candidateText);
    let bestMatch: { canonicalId: string; similarity: number } | null = null;

    // Check against all canonical entities of the same type
    for (const [canonicalId, entity] of this.canonicalEntities.entries()) {
      if (!canonicalId.startsWith(`${candidateType.toLowerCase()}:`)) {
        continue;
      }

      // Check normalized text
      const similarity = calculateSimilarity(normalizedCandidate, entity.normalizedText);
      if (!bestMatch || similarity > bestMatch.similarity) {
        bestMatch = { canonicalId, similarity };
      }

      // Check aliases
      for (const alias of entity.aliases) {
        const aliasNormalized = normalizeEntityText(alias);
        const aliasSimilarity = calculateSimilarity(normalizedCandidate, aliasNormalized);
        if (!bestMatch || aliasSimilarity > bestMatch.similarity) {
          bestMatch = { canonicalId, similarity: aliasSimilarity };
        }
      }
    }

    if (!bestMatch) {
      return null;
    }

    const isAlias = bestMatch.similarity >= this.similarityThreshold;
    const ambiguous =
      bestMatch.similarity >= this.ambiguousThreshold.min &&
      bestMatch.similarity < this.ambiguousThreshold.max;

    // Log ambiguity for tuning
    if (ambiguous) {
      pceLogger.warn("Ambiguous entity resolution", {
        candidate: candidateText,
        canonical: bestMatch.canonicalId,
        similarity: bestMatch.similarity,
      });
    }

    // Log successful merge
    if (isAlias) {
      pceLogger.info("Entity alias resolved", {
        candidate: candidateText,
        canonical: bestMatch.canonicalId,
        similarity: bestMatch.similarity,
      });
    }

    return {
      canonicalId: bestMatch.canonicalId,
      similarity: bestMatch.similarity,
      isAlias,
      ambiguous,
    };
  }

  /**
   * Get all canonical entities
   */
  getAllCanonical(): Map<string, { normalizedText: string; aliases: string[] }> {
    return new Map(this.canonicalEntities);
  }

  /**
   * Clear all mappings
   */
  clear(): void {
    this.canonicalEntities.clear();
  }
}
