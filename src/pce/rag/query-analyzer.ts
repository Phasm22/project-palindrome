/**
 * Phase I-C: Query Analyzer and Router
 * Task 8.1: Query Analysis and Routing Module
 */

import type { QueryAnalysis, QueryType, ExtractedQueryEntity } from "../types";
import { QueryEntityResolver, type EntityResolutionResult } from "./query-entity-resolver";
import { pceLogger } from "../utils/logger";

/**
 * Query Analyzer
 * Classifies queries and extracts structural indicators
 */
export class QueryAnalyzer {
  private entityResolver: QueryEntityResolver;

  constructor(entityResolver: QueryEntityResolver) {
    this.entityResolver = entityResolver;
  }

  /**
   * Task 8.1: Analyze query and determine routing type
   */
  async analyzeQuery(query: string): Promise<QueryAnalysis> {
    try {
      pceLogger.debug("Analyzing query", { query });

      // Extract structural indicators
      const structuralIndicators = this.detectStructuralIndicators(query);

      // Resolve entities
      const resolutionResult = await this.entityResolver.resolveEntities(query);

      // Determine query type based on indicators and entity resolution
      const queryType = this.determineQueryType(
        query,
        structuralIndicators,
        resolutionResult
      );

      pceLogger.info("Query analysis complete", {
        queryType,
        entityCount: resolutionResult.entities.length,
        resolvedCount: resolutionResult.entities.filter((e) => e.resolved).length,
        structuralIndicators: structuralIndicators.length,
      });

      return {
        queryType,
        entities: resolutionResult.entities,
        structuralIndicators,
      };
    } catch (error: any) {
      pceLogger.error("Query analysis failed", { error: error.message });
      // Default to SEMANTIC_ONLY on error
      return {
        queryType: "SEMANTIC_ONLY",
        entities: [],
        structuralIndicators: [],
      };
    }
  }

  /**
   * Detect structural query indicators
   */
  private detectStructuralIndicators(query: string): string[] {
    const indicators: string[] = [];
    const lowerQuery = query.toLowerCase();

    // Connection/relationship indicators
    const connectionPatterns = [
      "connect",
      "connected to",
      "links to",
      "related to",
      "depends on",
      "uses",
      "calls",
      "depends",
    ];

    for (const pattern of connectionPatterns) {
      if (lowerQuery.includes(pattern)) {
        indicators.push(pattern);
      }
    }

    // Path/traversal indicators
    const pathPatterns = [
      "path between",
      "path from",
      "route from",
      "trace",
      "traverse",
      "reach",
    ];

    for (const pattern of pathPatterns) {
      if (lowerQuery.includes(pattern)) {
        indicators.push(pattern);
      }
    }

    // Structural query patterns
    const structuralPatterns = [
      "what connects",
      "what links",
      "what depends",
      "what uses",
      "which hosts",
      "which services",
      "all alerts",
      "all connections",
    ];

    for (const pattern of structuralPatterns) {
      if (lowerQuery.includes(pattern)) {
        indicators.push(pattern);
      }
    }

    // Entity-specific structural queries
    const entityStructuralPatterns = [
      /(?:what|which|all)\s+(?:hosts?|servers?|nodes?)/i,
      /(?:what|which|all)\s+(?:services?|ports?|apps?)/i,
      /(?:what|which|all)\s+(?:alerts?|warnings?|alarms?)/i,
      /(?:what|which|all)\s+(?:networks?|subnets?|vlans?)/i,
    ];

    for (const pattern of entityStructuralPatterns) {
      if (pattern.test(query)) {
        indicators.push("entity_query");
      }
    }

    return indicators;
  }

  /**
   * Determine query type based on analysis
   */
  private determineQueryType(
    query: string,
    structuralIndicators: string[],
    resolutionResult: EntityResolutionResult
  ): QueryType {
    // Task 8.2.1: If no entities resolve, downgrade to SEMANTIC_ONLY
    if (resolutionResult.noneResolved && structuralIndicators.length === 0) {
      return "SEMANTIC_ONLY";
    }

    // Strong structural indicators with resolved entities -> STRUCTURAL_PRIMARY
    if (structuralIndicators.length > 0 && resolutionResult.someResolved) {
      // Check for strong structural patterns
      const strongStructuralPatterns = [
        "path between",
        "path from",
        "what connects",
        "what links",
        "connected to",
      ];

      const hasStrongPattern = structuralIndicators.some((indicator) =>
        strongStructuralPatterns.some((pattern) => indicator.includes(pattern))
      );

      if (hasStrongPattern) {
        return "STRUCTURAL_PRIMARY";
      }
    }

    // Task 8.2.2: Partial resolution -> HYBRID with lower structural weight
    if (resolutionResult.someResolved && !resolutionResult.allResolved) {
      return "HYBRID";
    }

    // Resolved entities with structural indicators -> HYBRID
    if (resolutionResult.allResolved && structuralIndicators.length > 0) {
      return "HYBRID";
    }

    // Resolved entities but no strong structural indicators -> HYBRID (can still benefit from graph)
    if (resolutionResult.allResolved) {
      return "HYBRID";
    }

    // Default: SEMANTIC_ONLY
    return "SEMANTIC_ONLY";
  }
}

