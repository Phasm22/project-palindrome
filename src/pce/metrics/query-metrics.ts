/**
 * Query Performance Metrics
 * Task 13.2: Graph Query Performance Metrics
 */

import { MetricsCollector } from "./collector";

export interface QueryComplexity {
  nodeCount?: number;
  relationshipDepth?: number;
  resultCount?: number;
  queryType?: string;
}

/**
 * Query performance metrics tracking
 */
export class QueryMetrics {
  private collector: MetricsCollector;

  constructor(collector: MetricsCollector) {
    this.collector = collector;
  }

  /**
   * Record graph query execution time and complexity
   */
  recordQuery(
    executionTimeMs: number,
    complexity: QueryComplexity,
    queryType: "vector" | "graph" | "hybrid"
  ): void {
    this.collector.record(`query_latency_${queryType}_ms`, executionTimeMs, {
      queryType,
    });

    if (complexity.nodeCount !== undefined) {
      this.collector.record("query_complexity_node_count", complexity.nodeCount, {
        queryType,
      });
    }

    if (complexity.relationshipDepth !== undefined) {
      this.collector.record(
        "query_complexity_relationship_depth",
        complexity.relationshipDepth,
        { queryType }
      );
    }

    if (complexity.resultCount !== undefined) {
      this.collector.record("query_result_count", complexity.resultCount, {
        queryType,
      });
    }

    // Flag slow queries (> 1 second)
    if (executionTimeMs > 1000) {
      this.collector.record("query_slow_queries", 1, {
        queryType,
        executionTimeMs: executionTimeMs.toString(),
      });
    }
  }
}

