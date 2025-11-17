/**
 * Ingestion Metrics
 * Task 13.1: Ingestion Latency and Throughput Metrics
 */

import { MetricsCollector } from "./collector";

export interface IngestionLatencyMetrics {
  webhookReceived: Date;
  processingStarted: Date;
  processingCompleted: Date;
  indexCommitted: Date;
}

export type IngestionMetricsRecordLatency = IngestionLatencyMetrics;

/**
 * Ingestion metrics tracking
 */
export class IngestionMetrics {
  private collector: MetricsCollector;

  constructor(collector: MetricsCollector) {
    this.collector = collector;
  }

  /**
   * Record end-to-end ingestion latency
   */
  recordLatency(metrics: IngestionLatencyMetrics): void {
    const totalLatency =
      metrics.indexCommitted.getTime() - metrics.webhookReceived.getTime();
    const processingLatency =
      metrics.processingCompleted.getTime() - metrics.processingStarted.getTime();
    const indexingLatency =
      metrics.indexCommitted.getTime() - metrics.processingCompleted.getTime();

    this.collector.record("ingestion_latency_total_ms", totalLatency);
    this.collector.record("ingestion_latency_processing_ms", processingLatency);
    this.collector.record("ingestion_latency_indexing_ms", indexingLatency);
  }

  /**
   * Record throughput (documents/chunks per minute)
   */
  recordThroughput(documentsProcessed: number, chunksIndexed: number, durationMs: number): void {
    const documentsPerMinute = (documentsProcessed / durationMs) * 60000;
    const chunksPerMinute = (chunksIndexed / durationMs) * 60000;

    this.collector.record("ingestion_throughput_documents_per_min", documentsPerMinute);
    this.collector.record("ingestion_throughput_chunks_per_min", chunksPerMinute);
  }

  /**
   * Record document processing
   */
  recordDocumentProcessed(status: "NEW" | "MODIFIED" | "UNCHANGED", chunksCount: number): void {
    this.collector.record("ingestion_documents_processed", 1, { status });
    this.collector.record("ingestion_chunks_indexed", chunksCount, { status });
  }
}

