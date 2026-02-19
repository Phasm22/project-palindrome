/**
 * Phase I-C: Hybrid Orchestrator
 * Task 8.3: Synchronous Retrieval Execution
 * Task 10.1: Failure Mode 1: Graph Down (Vector Only)
 * Task 10.2: Failure Mode 2: Low S_Total (No Answer)
 * Task 11.1: LLM Context Synthesis (Hybrid)
 */

import type {
  ACLGroup,
  HybridRAGResponse,
  QueryType,
  HybridContext,
  FusionConfig,
  RetrievalResult,
  RAGResponse,
} from "../types";
import { QueryAnalyzer } from "./query-analyzer";
import { RetrievalService } from "./retrieval";
import { GraphRAGRetrieval } from "../graph-retrieval/graph-rag";
import { FusionEngine } from "./fusion";
import { GenerationService } from "./generation";
import { pceLogger } from "../utils/logger";
import { AccessDeniedError } from "../errors";

export interface HybridOrchestratorConfig {
  fusionConfig?: Partial<FusionConfig>;
  retrievalTimeout?: number; // milliseconds
}

/**
 * Hybrid Orchestrator
 * Coordinates query analysis, parallel retrieval, fusion, and generation
 */
interface CacheEntry {
  response: HybridRAGResponse;
  timestamp: number;
}

export class HybridOrchestrator {
  private queryAnalyzer: QueryAnalyzer;
  private retrievalService: RetrievalService;
  private graphRetrieval: GraphRAGRetrieval;
  private fusionEngine: FusionEngine;
  private generationService: GenerationService;
  private config: HybridOrchestratorConfig;
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTTL = 30000; // 30 seconds for common queries

  constructor(
    queryAnalyzer: QueryAnalyzer,
    retrievalService: RetrievalService,
    graphRetrieval: GraphRAGRetrieval,
    fusionEngine: FusionEngine,
    generationService: GenerationService,
    config: HybridOrchestratorConfig = {}
  ) {
    this.queryAnalyzer = queryAnalyzer;
    this.retrievalService = retrievalService;
    this.graphRetrieval = graphRetrieval;
    this.fusionEngine = fusionEngine;
    this.generationService = generationService;
    this.config = {
      retrievalTimeout: 30000, // 30 seconds default
      ...config,
    };
  }

  /**
   * Main query method - orchestrates the entire hybrid RAG pipeline
   */
  async query(
    userQuery: string,
    userACLGroup: ACLGroup
  ): Promise<HybridRAGResponse> {
    try {
      pceLogger.info("Starting hybrid RAG query", {
        query: userQuery.slice(0, 100),
        aclGroup: userACLGroup,
      });

      // Check cache for common queries (temperature, status checks, etc.)
      // Skip cache for action queries (restart, start, stop, etc.) as they're time-sensitive
      const isActionQuery = /\b(restart|start|stop|create|destroy|install|configure|set|put|assign)\b/i.test(userQuery);
      const cacheKey = `${userQuery.toLowerCase().trim()}:${userACLGroup}`;
      const cached = this.cache.get(cacheKey);
      if (!isActionQuery && cached && (Date.now() - cached.timestamp) < this.cacheTTL) {
        pceLogger.debug("Cache hit for RAG query", { query: userQuery.slice(0, 50) });
        return cached.response;
      }
      
      if (isActionQuery) {
        pceLogger.debug("Skipping cache for action query", { query: userQuery.slice(0, 50) });
      }

      // Step 0: Check for exact-match VM/container names before semantic search
      // This improves recall for queries like "what is vm-123" or "where is container-456"
      const exactMatchResult = await this.tryExactMatchFallback(userQuery, userACLGroup);
      if (exactMatchResult) {
        pceLogger.info("Exact match found, bypassing semantic search", {
          query: userQuery.slice(0, 100),
        });
        // Cache exact match results
        this.cache.set(cacheKey, { response: exactMatchResult, timestamp: Date.now() });
        return exactMatchResult;
      }

      // Step 1: Analyze query and determine routing
      const analysis = await this.queryAnalyzer.analyzeQuery(userQuery);

      pceLogger.info("Query analysis complete", {
        queryType: analysis.queryType,
        entityCount: analysis.entities.length,
      });

      // Step 2: Route to appropriate retrieval path(s)
      let response: HybridRAGResponse;

      if (analysis.queryType === "SEMANTIC_ONLY") {
        response = await this.handleSemanticOnly(userQuery, userACLGroup);
      } else if (analysis.queryType === "STRUCTURAL_PRIMARY") {
        response = await this.handleStructuralPrimary(
          userQuery,
          userACLGroup,
          analysis
        );
      } else {
        // HYBRID
        response = await this.handleHybrid(
          userQuery,
          userACLGroup,
          analysis
        );
      }

      // Log counters
      pceLogger.logCounters();

      // Cache response for common query patterns (temperature, status, etc.)
      const isCacheable = this.isCacheableQuery(userQuery);
      if (isCacheable) {
        this.cache.set(cacheKey, { response, timestamp: Date.now() });
        // Clean old cache entries periodically
        if (this.cache.size > 100) {
          this.cleanCache();
        }
      }

      return response;
    } catch (error: any) {
      pceLogger.error("Hybrid RAG query failed", { error: error.message });
      throw error;
    }
  }

  /**
   * Handle SEMANTIC_ONLY queries (vector retrieval only)
   */
  private async handleSemanticOnly(
    query: string,
    aclGroup: ACLGroup
  ): Promise<HybridRAGResponse> {
    pceLogger.info("Routing to semantic-only retrieval");

    const retrievalResult = await this.retrievalService.retrieve(query, aclGroup);
    this.ensureSemanticAccess(retrievalResult);
    const context = this.buildSemanticContext(retrievalResult);
    const response = await this.generationService.generate(query, retrievalResult.chunks);
    const responseWithProvenance = this.attachProvenance(response, context);
    const sTotalScore = this.getMaxVectorScore(retrievalResult);

    // Detect real-time queries that may need tool execution for accurate results
    const realTimeQueryPatterns = [
      /\b(turn on|turn off|start|stop|shutdown|reboot|status|state|running|stopped)\b/i,
      /\b(current|now|currently|real.?time|live)\b/i,
    ];
    const isRealTimeQuery = realTimeQueryPatterns.some((pattern) => pattern.test(query));
    
    // Append note for real-time queries about potential stale data
    let answer = responseWithProvenance.answer;
    if (isRealTimeQuery) {
      answer += "\n\n⚠️ **Note:** This response is based on ingested data and may be stale. For real-time VM/container status or control operations, use the REPL (`bun src/cli.ts repl`) which executes tools to get current state.";
    }

    return {
      ...responseWithProvenance,
      answer,
      queryType: "SEMANTIC_ONLY",
      fallbackMode: null,
      context,
      sTotalScore,
    };
  }

  /**
   * Handle STRUCTURAL_PRIMARY queries (graph retrieval only)
   */
  private async handleStructuralPrimary(
    query: string,
    aclGroup: ACLGroup,
    analysis: any
  ): Promise<HybridRAGResponse> {
    pceLogger.info("Routing to structural-primary retrieval");

    try {
      const graphResult = await this.graphRetrieval.retrieve(query, "entities", aclGroup);
      const hybridContext: HybridContext = {
        semanticChunks: [],
        structuralPaths: [
          {
            entities: graphResult.entities,
            relationships: graphResult.relationships,
            score: 1.0,
          },
        ],
        provenance: graphResult.provenance,
      };

      const response = await this.generateHybridResponse(query, hybridContext);
      const structuralScore = hybridContext.structuralPaths[0]?.score ?? 0;

      return {
        ...response,
        queryType: "STRUCTURAL_PRIMARY",
        fallbackMode: null,
        context: hybridContext,
        sTotalScore: structuralScore,
      };
    } catch (error: any) {
      pceLogger.warn("Graph retrieval failed, falling back to semantic", {
        error: error.message,
      });
      // Task 10.1: Fallback to vector-only
      return await this.handleGraphDownFallback(query, aclGroup);
    }
  }

  /**
   * Task 8.3: Handle HYBRID queries (parallel vector + graph retrieval)
   */
  private async handleHybrid(
    query: string,
    aclGroup: ACLGroup,
    analysis: any
  ): Promise<HybridRAGResponse> {
    pceLogger.info("Routing to hybrid retrieval");

    // Task 8.3: Parallel retrieval execution
    let vectorResult;
    let graphResult;
    let graphFailed = false;

    try {
      // Execute both retrievals in parallel with timeout
      const [vectorPromise, graphPromise] = await Promise.allSettled([
        this.retrievalService.retrieve(query, aclGroup),
        this.timeoutPromise(
          this.graphRetrieval.retrieve(query, "entities", aclGroup),
          this.config.retrievalTimeout!
        ),
      ]);

      // Process vector result
      if (vectorPromise.status === "fulfilled") {
        vectorResult = vectorPromise.value;
        this.ensureSemanticAccess(vectorResult);
      } else {
        pceLogger.error("Vector retrieval failed", {
          error: vectorPromise.reason?.message,
        });
        throw new Error("Vector retrieval failed");
      }

      // Process graph result
      if (graphPromise.status === "fulfilled") {
        graphResult = graphPromise.value;
      } else {
        pceLogger.warn("Graph retrieval failed or timed out", {
          error: graphPromise.reason?.message,
        });
        graphFailed = true;
        // Task 10.1: Fallback to vector-only
        return await this.handleGraphDownFallback(query, aclGroup);
      }
    } catch (error: any) {
      // Task 10.1: If graph connection fails, fallback to vector-only
      if (error.message.includes("connect") || error.message.includes("ECONNREFUSED")) {
        return await this.handleGraphDownFallback(query, aclGroup);
      }
      throw error;
    }

    // Fuse results
    const fusionResult = await this.fusionEngine.fuse(vectorResult, graphResult);

    // Task 10.2: Check if final score is below threshold
    const avgTotalScore =
      fusionResult.fusionScores.length > 0
        ? fusionResult.fusionScores.reduce((sum, s) => sum + s.totalScore, 0) /
          fusionResult.fusionScores.length
        : 0;

    // Access fusion config through a getter or direct access
    const fusionConfig = (this.fusionEngine as any).config as FusionConfig;
    const minTotalScore = fusionConfig?.minTotalScore || 0.65;

    // Even if score is below threshold, still generate response if we have context
    // The LLM can use partial context to provide a better answer
    if (avgTotalScore < minTotalScore && fusionResult.fusionScores.length > 0) {
      pceLogger.warn("Fusion score below threshold, but proceeding with available context", {
        avgTotalScore,
        threshold: minTotalScore,
        contextItems: fusionResult.prunedContext.semanticChunks.length + fusionResult.prunedContext.structuralPaths.length,
      });
      
      // Still generate response with available context - don't block on threshold
      const response = await this.generateHybridResponse(
        query,
        fusionResult.prunedContext
      );

      return {
        ...response,
        queryType: "HYBRID",
        fallbackMode: "low_score",
        context: fusionResult.prunedContext,
        sTotalScore: avgTotalScore,
        fusionMetrics: {
          vectorResults: vectorResult.chunks.length,
          graphResults: graphResult.entities.length,
          fusedResults: fusionResult.fusionScores.length,
          prunedResults:
            fusionResult.prunedContext.semanticChunks.length +
            fusionResult.prunedContext.structuralPaths.length,
          avgTotalScore,
        },
      };
    }

    // Generate response from fused context
    const response = await this.generateHybridResponse(
      query,
      fusionResult.prunedContext
    );

    return {
      ...response,
      queryType: "HYBRID",
      fallbackMode: null,
      context: fusionResult.prunedContext,
      sTotalScore: avgTotalScore,
      fusionMetrics: {
        vectorResults: vectorResult.chunks.length,
        graphResults: graphResult.entities.length,
        fusedResults: fusionResult.fusionScores.length,
        prunedResults:
          fusionResult.prunedContext.semanticChunks.length +
          fusionResult.prunedContext.structuralPaths.length,
        avgTotalScore,
      },
    };
  }

  /**
   * Task 10.1: Handle graph down fallback (vector-only)
   */
  private async handleGraphDownFallback(
    query: string,
    aclGroup: ACLGroup
  ): Promise<HybridRAGResponse> {
    pceLogger.warn("Graph DB unavailable, falling back to vector-only retrieval");
    pceLogger.incrementCounter("fallback_graph_down_count");

    const retrievalResult = await this.retrievalService.retrieve(query, aclGroup);
    this.ensureSemanticAccess(retrievalResult);
    const context = this.buildSemanticContext(retrievalResult);
    const response = await this.generationService.generate(query, retrievalResult.chunks);
    const responseWithProvenance = this.attachProvenance(response, context);
    const sTotalScore = this.getMaxVectorScore(retrievalResult);

    // Detect real-time queries that may need tool execution for accurate results
    const realTimeQueryPatterns = [
      /\b(turn on|turn off|start|stop|shutdown|reboot|status|state|running|stopped)\b/i,
      /\b(current|now|currently|real.?time|live)\b/i,
    ];
    const isRealTimeQuery = realTimeQueryPatterns.some((pattern) => pattern.test(query));
    
    // Append note for real-time queries about potential stale data
    let answer = responseWithProvenance.answer;
    if (isRealTimeQuery) {
      answer += "\n\n⚠️ **Note:** This response is based on ingested data and may be stale. For real-time VM/container status or control operations, use the REPL (`bun src/cli.ts repl`) which executes tools to get current state.";
    }

    return {
      ...responseWithProvenance,
      answer,
      queryType: "SEMANTIC_ONLY",
      fallbackMode: "graph_down",
      context,
      sTotalScore,
    };
  }

  /**
   * Task 11.1: Generate response from hybrid context
   */
  private async generateHybridResponse(
    query: string,
    context: HybridContext
  ): Promise<RAGResponse> {
    // Convert hybrid context to format for generation service
    const chunks = context.semanticChunks.map((item) => item.chunk);
    
    // Format structural paths for LLM
    const structuralContext = this.formatStructuralContext(context.structuralPaths);

    // Combine semantic and structural context
    const fullContext = [
      ...chunks.map((c) => c.text),
      ...structuralContext,
    ].join("\n\n");

    // Create a combined chunk for generation
    const combinedChunk = {
      id: "hybrid-context",
      text: fullContext,
      metadata: {
        versionHash: "",
        aclGroup: "admin" as ACLGroup,
        sourceType: "generic_text" as const,
        sourcePath: "hybrid",
        timestamp: new Date(),
        chunkIndex: 0,
        totalChunks: 1,
      },
      startIndex: 0,
      endIndex: fullContext.length,
    };

    const response = await this.generationService.generate(query, [combinedChunk]);

    // Add provenance to sources
    const sourcesWithProvenance = response.sources.map((source, index) => {
      // Find matching provenance
      const provenance = context.provenance.find(
        (p) => p.sourcePath === source.sourcePath
      );
      return {
        ...source,
        ...(provenance && { versionHash: provenance.versionHash }),
      };
    });

    // Detect real-time queries that may need tool execution for accurate results
    const realTimeQueryPatterns = [
      /\b(turn on|turn off|start|stop|shutdown|reboot|status|state|running|stopped)\b/i,
      /\b(current|now|currently|real.?time|live)\b/i,
    ];
    const isRealTimeQuery = realTimeQueryPatterns.some((pattern) => pattern.test(query));
    
    // Append note for real-time queries about potential stale data
    let answer = response.answer;
    if (isRealTimeQuery) {
      answer += "\n\n⚠️ **Note:** This response is based on ingested data and may be stale. For real-time VM/container status or control operations, use the REPL (`bun src/cli.ts repl`) which executes tools to get current state.";
    }

    return {
      ...response,
      answer,
      sources: sourcesWithProvenance,
      metadata: {
        ...response.metadata,
        chunksRetrieved: chunks.length + context.structuralPaths.length,
      },
    };
  }

  private attachProvenance(
    response: RAGResponse,
    context: HybridContext
  ): RAGResponse {
    if (!context.semanticChunks.length && !context.provenance.length) {
      return response;
    }

    const chunkMap = new Map(
      context.semanticChunks.map((item) => [item.chunk.id, item.chunk])
    );

    const provenanceByPath = new Map(
      context.provenance.map((entry) => [entry.sourcePath, entry])
    );

    const enrichedSources = response.sources.map((source) => {
      const chunk = chunkMap.get(source.chunkId);
      if (chunk) {
        return {
          ...source,
          versionHash: chunk.metadata.versionHash,
        };
      }

      const provenance = provenanceByPath.get(source.sourcePath);
      if (provenance) {
        return {
          ...source,
          versionHash: provenance.versionHash,
        };
      }

      return source;
    });

    return {
      ...response,
      sources: enrichedSources,
    };
  }

  private buildSemanticContext(result: RetrievalResult): HybridContext {
    const provenanceMap = new Map<string, { versionHash: string; sourcePath: string }>();

    result.chunks.forEach((chunk) => {
      provenanceMap.set(chunk.metadata.sourcePath, {
        versionHash: chunk.metadata.versionHash,
        sourcePath: chunk.metadata.sourcePath,
      });
    });

    return {
      semanticChunks: result.chunks.map((chunk, index) => ({
        chunk,
        score: result.scores[index] ?? 0,
      })),
      structuralPaths: [],
      provenance: Array.from(provenanceMap.values()),
    };
  }

  private getMaxVectorScore(result: RetrievalResult): number | null {
    if (!result.scores.length) {
      return null;
    }
    return Math.max(...result.scores);
  }

  private ensureSemanticAccess(result: RetrievalResult): void {
    if (result.accessDeniedInfo) {
      throw new AccessDeniedError(result.accessDeniedInfo);
    }
  }

  /**
   * Format structural paths for LLM consumption
   */
  private formatStructuralContext(
    paths: HybridContext["structuralPaths"]
  ): string[] {
    return paths.map((path, index) => {
      const entityDescriptions = path.entities
        .map((e) => `${e.type} ${e.id}: ${JSON.stringify(e.attributes)}`)
        .join("\n");
      const relationshipDescriptions = path.relationships
        .map((r) => `${r.from} --[${r.type}]--> ${r.to}`)
        .join("\n");

      return `Structural Path ${index + 1}:\nEntities:\n${entityDescriptions}\n\nRelationships:\n${relationshipDescriptions}`;
    });
  }

  /**
   * Timeout wrapper for promises
   */
  private async timeoutPromise<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error("Operation timed out")), timeoutMs)
      ),
    ]);
  }

  /**
   * Try exact-match fallback for VM/container names
   * If query looks like a VM name (e.g., "vm-123", "container-456"), check graph first
   * Returns response if exact match found, null otherwise
   */
  private async tryExactMatchFallback(
    query: string,
    aclGroup: ACLGroup
  ): Promise<HybridRAGResponse | null> {
    try {
      // Extract potential VM/container names from query
      // Patterns: "vm-123", "container-456", "lxc-789", "qemu-101", or just "123" if context suggests VM
      const vmNamePatterns = [
        /\b(?:vm|container|lxc|qemu|ct)[-_]?(\d+)\b/gi,
        /\b(\d{3,})\b/g, // 3+ digit numbers (likely VMIDs)
      ];

      const potentialVmNames: string[] = [];
      for (const pattern of vmNamePatterns) {
        const matches = query.matchAll(pattern);
        for (const match of matches) {
          const vmName = match[0].toLowerCase();
          if (!potentialVmNames.includes(vmName)) {
            potentialVmNames.push(vmName);
          }
        }
      }

      // If no VM-like patterns found, skip exact match
      if (potentialVmNames.length === 0) {
        return null;
      }

      // Try to find exact matches in graph
      for (const vmName of potentialVmNames) {
        try {
          // Query graph for exact match by name or ID
          const graphResult = await this.graphRetrieval.retrieve(
            vmName,
            "entities",
            aclGroup
          );

          // If we found entities, check if any match exactly
          const exactMatches = graphResult.entities.filter((e: any) => {
            const entityName = (e.name || e.id || "").toLowerCase();
            const normalizedVmName = vmName.replace(/[-_]/g, "").toLowerCase();
            const normalizedEntityName = entityName.replace(/[-_]/g, "").toLowerCase();
            return (
              entityName === vmName ||
              normalizedEntityName === normalizedVmName ||
              entityName.includes(vmName) ||
              vmName.includes(entityName)
            );
          });

          if (exactMatches.length > 0) {
            pceLogger.info("Exact match found in graph", {
              vmName,
              matches: exactMatches.length,
            });

            // Build context from exact match
            // Convert graph entities to structural path format
            const structuralPaths = exactMatches.map((e: any) => ({
              entities: [e],
              relationships: [],
              score: 1.0, // Exact match = perfect score
            }));

            const context: HybridContext = {
              semanticChunks: [],
              structuralPaths,
              provenance: [],
            };

            // Generate response using exact match context
            const response = await this.generateHybridResponse(query, context);

            return {
              ...response,
              queryType: "HYBRID",
              fallbackMode: null,
              context,
              sTotalScore: 1.0, // Exact match = perfect score
              fusionMetrics: {
                vectorResults: 0,
                graphResults: exactMatches.length,
                fusedResults: exactMatches.length,
                prunedResults: exactMatches.length,
                avgTotalScore: 1.0,
              },
            };
          }
        } catch (error: any) {
          // If graph query fails, continue to normal flow
          pceLogger.debug("Exact match graph query failed, continuing", {
            vmName,
            error: error.message,
          });
        }
      }

      // No exact matches found
      return null;
    } catch (error: any) {
      // If exact match check fails, continue to normal flow
      pceLogger.debug("Exact match fallback failed, continuing", {
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Check if query is cacheable (deterministic queries like temperature, status)
   */
  private isCacheableQuery(query: string): boolean {
    const lowerQuery = query.toLowerCase();
    const cacheablePatterns = [
      /temperature/i,
      /temp/i,
      /status/i,
      /health/i,
      /uptime/i,
      /all nodes/i,
      /all the nodes/i,
    ];
    return cacheablePatterns.some(pattern => pattern.test(lowerQuery));
  }

  /**
   * Clean old cache entries
   */
  private cleanCache() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.cacheTTL) {
        this.cache.delete(key);
      }
    }
  }
}
