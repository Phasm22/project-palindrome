/**
 * Phase I-C: Retrieval Fusion Strategy
 * Task 9.1: Context Score Normalization
 * Task 9.1.1: Pre-Fusion Score Floor Enforcement
 * Task 9.2: Weighted Fusion Engine Implementation
 * Task 9.3: Metadata and Relationship Pruning
 */

import type {
  RetrievalResult,
  GraphRetrievalResult,
  FusionConfig,
  FusionWeights,
  HybridContext,
  HybridRetrievalResult,
  DocumentChunk,
} from "../types";
import { pceLogger } from "../utils/logger";

const DEFAULT_FUSION_WEIGHTS: FusionWeights = {
  vector: 0.5,
  graph: 0.4,
  recency: 0.1,
};

const DEFAULT_FUSION_CONFIG: FusionConfig = {
  weights: DEFAULT_FUSION_WEIGHTS,
  minVectorScore: 0.1, // Lowered from 0.30 for short structural documents (Proxmox inventory)
  minGraphScore: 0.40,
  minTotalScore: 0.25, // Lowered from 0.65 for short structural documents (Proxmox inventory) - vector scores ~0.35 are good matches
  maxTokens: 4096,
};

/**
 * Fusion Engine
 * Combines vector and graph retrieval results with weighted scoring
 */
export class FusionEngine {
  private config: FusionConfig;

  constructor(config: Partial<FusionConfig> = {}) {
    this.config = { ...DEFAULT_FUSION_CONFIG, ...config };
  }

  /**
   * Task 9.2: Fuse vector and graph retrieval results
   */
  async fuse(
    vectorResult: RetrievalResult,
    graphResult: GraphRetrievalResult
  ): Promise<HybridRetrievalResult> {
    try {
      pceLogger.info("Starting fusion", {
        vectorChunks: vectorResult.chunks.length,
        graphEntities: graphResult.entities.length,
        graphRelationships: graphResult.relationships.length,
      });

      // Task 9.1: Normalize scores
      const normalizedVector = this.normalizeVectorScores(vectorResult);
      const normalizedGraph = this.normalizeGraphScores(graphResult);

      // Task 9.1.1: Apply pre-fusion score floors
      const filteredVector = this.applyScoreFloors(normalizedVector, "vector");
      const filteredGraph = this.applyScoreFloors(normalizedGraph, "graph");

      // Calculate fusion scores
      const fusionScores = this.calculateFusionScores(
        filteredVector,
        filteredGraph
      );

      // Task 9.3: Prune and build hybrid context
      const prunedContext = this.pruneAndBuildContext(
        filteredVector,
        filteredGraph,
        fusionScores
      );

      pceLogger.info("Fusion complete", {
        originalVectorChunks: vectorResult.chunks.length,
        originalGraphEntities: graphResult.entities.length,
        fusedItems: fusionScores.length,
        prunedItems: prunedContext.semanticChunks.length + prunedContext.structuralPaths.length,
      });

      return {
        vectorResult: filteredVector,
        graphResult: filteredGraph,
        fusionScores,
        prunedContext,
      };
    } catch (error: any) {
      pceLogger.error("Fusion failed", { error: error.message });
      throw error;
    }
  }

  /**
   * Task 9.1: Normalize vector similarity scores to [0.0, 1.0]
   * Vector scores are already in [0.0, 1.0] range (cosine similarity)
   * But we ensure consistency and handle edge cases
   */
  private normalizeVectorScores(result: RetrievalResult): RetrievalResult {
    const normalizedScores = result.scores.map((score) => {
      // Clamp to [0.0, 1.0]
      return Math.max(0.0, Math.min(1.0, score));
    });

    return {
      ...result,
      scores: normalizedScores,
    };
  }

  /**
   * Task 9.1: Normalize graph confidence scores to [0.0, 1.0]
   */
  private normalizeGraphScores(result: GraphRetrievalResult): GraphRetrievalResult {
    // Normalize entity confidence scores
    const normalizedEntities = result.entities.map((entity) => {
      const confidence = entity.confidence ?? 0.5; // Default confidence if not set
      return {
        ...entity,
        confidence: Math.max(0.0, Math.min(1.0, confidence)),
      };
    });

    // Normalize relationship confidence scores
    const normalizedRelationships = result.relationships.map((rel) => {
      const confidence = rel.confidence ?? 0.5; // Default confidence if not set
      return {
        ...rel,
        confidence: Math.max(0.0, Math.min(1.0, confidence)),
      };
    });

    return {
      ...result,
      entities: normalizedEntities,
      relationships: normalizedRelationships,
    };
  }

  /**
   * Task 9.1.1: Apply pre-fusion score floors
   */
  private applyScoreFloors<T extends RetrievalResult | GraphRetrievalResult>(
    result: T,
    type: "vector" | "graph"
  ): T {
    if (type === "vector") {
      const vectorResult = result as RetrievalResult;
      const filtered: DocumentChunk[] = [];
      const filteredScores: number[] = [];

      for (let i = 0; i < vectorResult.chunks.length; i++) {
        const chunk = vectorResult.chunks[i];
        const score = vectorResult.scores[i];
        if (!chunk || score === undefined) {
          continue;
        }
        if (score >= this.config.minVectorScore) {
          filtered.push(chunk);
          filteredScores.push(score);
        }
      }

      pceLogger.debug("Applied vector score floor", {
        originalCount: vectorResult.chunks.length,
        filteredCount: filtered.length,
        threshold: this.config.minVectorScore,
      });

      return {
        ...vectorResult,
        chunks: filtered,
        scores: filteredScores,
      } as T;
    } else {
      const graphResult = result as GraphRetrievalResult;
      const filteredEntities = graphResult.entities.filter(
        (entity) => (entity.confidence ?? 0.5) >= this.config.minGraphScore
      );
      const filteredRelationships = graphResult.relationships.filter(
        (rel) => (rel.confidence ?? 0.5) >= this.config.minGraphScore
      );

      pceLogger.debug("Applied graph score floor", {
        originalEntities: graphResult.entities.length,
        filteredEntities: filteredEntities.length,
        originalRelationships: graphResult.relationships.length,
        filteredRelationships: filteredRelationships.length,
        threshold: this.config.minGraphScore,
      });

      return {
        ...graphResult,
        entities: filteredEntities,
        relationships: filteredRelationships,
      } as T;
    }
  }

  /**
   * Task 9.2: Calculate weighted fusion scores
   * Formula: S_Total = W_Vector * S_Vector + W_Graph * S_Graph + W_Recency * S_Recency
   */
  private calculateFusionScores(
    vectorResult: RetrievalResult,
    graphResult: GraphRetrievalResult
  ): Array<{
    itemId: string;
    vectorScore: number;
    graphScore: number;
    recencyScore: number;
    totalScore: number;
  }> {
    const fusionScores: Array<{
      itemId: string;
      vectorScore: number;
      graphScore: number;
      recencyScore: number;
      totalScore: number;
    }> = [];

    // Create a map of source paths to vector scores for matching
    const vectorScoreMap = new Map<string, number>();
    for (let i = 0; i < vectorResult.chunks.length; i++) {
      const chunk = vectorResult.chunks[i];
      const score = vectorResult.scores[i];
      if (!chunk || score === undefined) {
        continue;
      }
      // Use source path as key for matching
      const key = chunk.metadata.sourcePath;
      // Keep highest score if multiple chunks from same source
      if (!vectorScoreMap.has(key) || vectorScoreMap.get(key)! < score) {
        vectorScoreMap.set(key, score);
      }
    }

    // Calculate fusion scores for graph entities
    for (const entity of graphResult.entities) {
      const vectorScore = vectorScoreMap.get(entity.sourcePath || "") || 0;
      const graphScore = entity.confidence ?? 0.5;
      const recencyScore = this.calculateRecencyScore(entity.sourcePath || "");

      const totalScore =
        this.config.weights.vector * vectorScore +
        this.config.weights.graph * graphScore +
        this.config.weights.recency * recencyScore;

      fusionScores.push({
        itemId: entity.id,
        vectorScore,
        graphScore,
        recencyScore,
        totalScore,
      });
    }

    // Calculate fusion scores for vector chunks not matched to graph entities
    for (let i = 0; i < vectorResult.chunks.length; i++) {
      const chunk = vectorResult.chunks[i];
      const vectorScore = vectorResult.scores[i];
      if (!chunk || vectorScore === undefined) {
        continue;
      }
      const sourcePath = chunk.metadata.sourcePath;

      // Check if this source path has a graph entity
      const hasGraphEntity = graphResult.entities.some(
        (e) => e.sourcePath === sourcePath
      );

      if (!hasGraphEntity) {
        // Pure vector result
        const recencyScore = this.calculateRecencyScore(sourcePath);
        const totalScore =
          this.config.weights.vector * vectorScore +
          this.config.weights.recency * recencyScore;

        fusionScores.push({
          itemId: chunk.id,
          vectorScore,
          graphScore: 0,
          recencyScore,
          totalScore,
        });
      }
    }

    // Sort by total score descending
    fusionScores.sort((a, b) => b.totalScore - a.totalScore);

    return fusionScores;
  }

  /**
   * Calculate recency score based on source path timestamp
   * Newer documents get higher scores
   */
  private calculateRecencyScore(sourcePath: string): number {
    // For now, use a default recency score
    // In production, this would use document timestamps
    // Default to 0.5 (neutral)
    return 0.5;
  }

  /**
   * Task 9.3: Prune and build hybrid context
   */
  private pruneAndBuildContext(
    vectorResult: RetrievalResult,
    graphResult: GraphRetrievalResult,
    fusionScores: Array<{
      itemId: string;
      vectorScore: number;
      graphScore: number;
      recencyScore: number;
      totalScore: number;
    }>
  ): HybridContext {
    // Filter by minimum total score threshold, but use a lower threshold for pruning
    // to ensure we don't lose good context (pruning threshold is separate from response threshold)
    const pruningThreshold = Math.min(this.config.minTotalScore, 0.15); // Lower threshold for pruning
    const aboveThreshold = fusionScores.filter(
      (score) => score.totalScore >= pruningThreshold
    );

    // Build semantic chunks
    const semanticChunks: Array<{ chunk: DocumentChunk; score: number }> = [];
    const chunkScoreMap = new Map<string, number>();

    for (const score of aboveThreshold) {
      // Find matching vector chunk
      const chunk = vectorResult.chunks.find((c) => c.id === score.itemId);
      if (chunk) {
        chunkScoreMap.set(chunk.id, score.totalScore);
        semanticChunks.push({
          chunk,
          score: score.totalScore,
        });
      }
    }

    // Build structural paths (group entities by source path)
    const structuralPaths: Array<{
      entities: GraphRetrievalResult["entities"];
      relationships: GraphRetrievalResult["relationships"];
      score: number;
    }> = [];

    const pathMap = new Map<string, {
      entities: GraphRetrievalResult["entities"];
      relationships: GraphRetrievalResult["relationships"];
      maxScore: number;
    }>();

    for (const entity of graphResult.entities) {
      const score = fusionScores.find((s) => s.itemId === entity.id);
      if (score && score.totalScore >= this.config.minTotalScore) {
        const sourcePath = entity.sourcePath || "unknown";
        if (!pathMap.has(sourcePath)) {
          pathMap.set(sourcePath, {
            entities: [],
            relationships: [],
            maxScore: 0,
          });
        }
        const path = pathMap.get(sourcePath)!;
        path.entities.push(entity);
        path.maxScore = Math.max(path.maxScore, score.totalScore);
      }
    }

    // Add relationships to paths
    for (const rel of graphResult.relationships) {
      const sourcePath = rel.sourcePath || "unknown";
      if (pathMap.has(sourcePath)) {
        pathMap.get(sourcePath)!.relationships.push(rel);
      }
    }

    // Convert path map to array
    for (const [sourcePath, path] of pathMap.entries()) {
      if (path.entities.length > 0 || path.relationships.length > 0) {
        structuralPaths.push({
          entities: path.entities,
          relationships: path.relationships,
          score: path.maxScore,
        });
      }
    }

    // Sort by score
    structuralPaths.sort((a, b) => b.score - a.score);

    // Apply token budget
    const prunedSemantic = this.applyTokenBudget(semanticChunks);
    const prunedStructural = this.applyTokenBudgetToPaths(structuralPaths);

    // Build provenance
    const provenanceMap = new Map<string, { versionHash: string; sourcePath: string }>();
    
    for (const chunk of prunedSemantic) {
      const versionHash = chunk.chunk.metadata.versionHash;
      const sourcePath = chunk.chunk.metadata.sourcePath;
      if (versionHash && sourcePath) {
        provenanceMap.set(versionHash, { versionHash, sourcePath });
      }
    }

    for (const path of prunedStructural) {
      for (const entity of path.entities) {
        if (entity.versionHash && entity.sourcePath) {
          provenanceMap.set(entity.versionHash, {
            versionHash: entity.versionHash,
            sourcePath: entity.sourcePath,
          });
        }
      }
    }

    return {
      semanticChunks: prunedSemantic,
      structuralPaths: prunedStructural,
      provenance: Array.from(provenanceMap.values()),
    };
  }

  /**
   * Apply token budget to semantic chunks
   */
  private applyTokenBudget(
    chunks: Array<{ chunk: DocumentChunk; score: number }>
  ): Array<{ chunk: DocumentChunk; score: number }> {
    const pruned: Array<{ chunk: DocumentChunk; score: number }> = [];
    let totalTokens = 0;

    for (const item of chunks) {
      const estimatedTokens = Math.ceil(item.chunk.text.length / 4);
      if (totalTokens + estimatedTokens > this.config.maxTokens) {
        pceLogger.debug("Token budget exceeded, pruning chunks", {
          tokensUsed: totalTokens,
          maxTokens: this.config.maxTokens,
        });
        break;
      }
      pruned.push(item);
      totalTokens += estimatedTokens;
    }

    return pruned;
  }

  /**
   * Apply token budget to structural paths
   */
  private applyTokenBudgetToPaths(
    paths: Array<{
      entities: GraphRetrievalResult["entities"];
      relationships: GraphRetrievalResult["relationships"];
      score: number;
    }>
  ): Array<{
    entities: GraphRetrievalResult["entities"];
    relationships: GraphRetrievalResult["relationships"];
    score: number;
  }> {
    // Estimate tokens for structural paths (rough: 100 tokens per entity/relationship)
    const pruned: Array<{
      entities: GraphRetrievalResult["entities"];
      relationships: GraphRetrievalResult["relationships"];
      score: number;
    }> = [];
    let totalTokens = 0;
    const tokensPerPath = 200; // Rough estimate

    for (const path of paths) {
      if (totalTokens + tokensPerPath > this.config.maxTokens) {
        pceLogger.debug("Token budget exceeded, pruning structural paths", {
          tokensUsed: totalTokens,
          maxTokens: this.config.maxTokens,
        });
        break;
      }
      pruned.push(path);
      totalTokens += tokensPerPath;
    }

    return pruned;
  }
}
