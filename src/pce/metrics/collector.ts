/**
 * Metrics Collector
 * Base metrics collection and aggregation
 */

import { pceLogger } from "../utils/logger";

export interface MetricEntry {
  name: string;
  value: number;
  timestamp: Date;
  tags?: Record<string, string>;
}

export interface MetricsSnapshot {
  timestamp: Date;
  metrics: Record<string, {
    count: number;
    sum: number;
    min: number;
    max: number;
    avg: number;
    latest: number;
  }>;
}

/**
 * Centralized metrics collector
 */
export class MetricsCollector {
  private metrics: Map<string, MetricEntry[]> = new Map();
  private maxEntriesPerMetric: number = 1000;
  private aggregationInterval: Timer | null = null;

  constructor() {
    // Start periodic aggregation and logging
    this.aggregationInterval = setInterval(() => {
      this.logAggregatedMetrics();
    }, 60000); // Log every minute
  }

  /**
   * Record a metric
   */
  record(name: string, value: number, tags?: Record<string, string>): void {
    const entry: MetricEntry = {
      name,
      value,
      timestamp: new Date(),
      tags,
    };

    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }

    const entries = this.metrics.get(name)!;
    entries.push(entry);

    // Keep only recent entries
    if (entries.length > this.maxEntriesPerMetric) {
      entries.shift();
    }

    pceLogger.debug(`Metric recorded`, { name, value, tags });
  }

  /**
   * Get aggregated metrics snapshot
   */
  getSnapshot(timeWindowMs?: number): MetricsSnapshot {
    const now = new Date();
    const windowStart = timeWindowMs
      ? new Date(now.getTime() - timeWindowMs)
      : new Date(0);

    const snapshot: MetricsSnapshot = {
      timestamp: now,
      metrics: {},
    };

    for (const [name, entries] of this.metrics.entries()) {
      // Filter by time window if specified
      const filteredEntries = entries.filter(
        (e) => e.timestamp >= windowStart
      );

      if (filteredEntries.length === 0) {
        continue;
      }

      const values = filteredEntries.map((e) => e.value);
      const sum = values.reduce((a, b) => a + b, 0);
      const count = values.length;
      const avg = sum / count;
      const min = Math.min(...values);
      const max = Math.max(...values);
      const latest = values[values.length - 1];

      snapshot.metrics[name] = {
        count,
        sum,
        min,
        max,
        avg,
        latest,
      };
    }

    return snapshot;
  }

  /**
   * Log aggregated metrics
   */
  private logAggregatedMetrics(): void {
    const snapshot = this.getSnapshot(60000); // Last minute

    if (Object.keys(snapshot.metrics).length === 0) {
      return;
    }

    pceLogger.info("Metrics snapshot (last minute)", snapshot.metrics);
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics.clear();
  }

  /**
   * Shutdown metrics collector
   */
  shutdown(): void {
    if (this.aggregationInterval) {
      clearInterval(this.aggregationInterval);
      this.aggregationInterval = null;
    }
  }
}

