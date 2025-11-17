/**
 * Queue Consumer
 * Task 12.2: Incremental Ingestion Pipeline Trigger
 * Pulls items from real-time queue and processes them through DLM and KG/EDL pipelines
 */

import { promises as fs } from "fs";
import { pceLogger } from "../utils/logger";
import { RealtimeIngestionQueue, type QueueItem } from "./queue";
import type { IngestionPipeline } from "../ingestion/pipeline";
import type { GraphIngestionPipeline } from "../ingestion/graph-pipeline";
import type { DocumentType, ACLGroup } from "../types";

export interface QueueConsumerOptions {
  pollInterval?: number; // milliseconds
  concurrency?: number; // max concurrent processing
  enableMetrics?: boolean;
}

/**
 * Queue Consumer for Real-Time Ingestion
 */
export class QueueConsumer {
  private queue: RealtimeIngestionQueue;
  private ingestionPipeline: IngestionPipeline;
  private graphPipeline?: GraphIngestionPipeline;
  private options: Required<QueueConsumerOptions>;
  private running: boolean = false;
  private pollTimer: Timer | null = null;
  private activeProcessing: Set<string> = new Set();

  constructor(
    queue: RealtimeIngestionQueue,
    ingestionPipeline: IngestionPipeline,
    graphPipeline?: GraphIngestionPipeline,
    options: QueueConsumerOptions = {}
  ) {
    this.queue = queue;
    this.ingestionPipeline = ingestionPipeline;
    this.graphPipeline = graphPipeline;
    this.options = {
      pollInterval: options.pollInterval || 100, // Poll every 100ms
      concurrency: options.concurrency || 10, // Process up to 10 items concurrently
      enableMetrics: options.enableMetrics !== false,
    };
  }

  /**
   * Start consuming from the queue
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Queue consumer is already running");
    }

    this.running = true;
    pceLogger.info("Queue consumer started", {
      pollInterval: this.options.pollInterval,
      concurrency: this.options.concurrency,
    });

    // Start polling loop
    this.poll();
  }

  /**
   * Stop consuming from the queue
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Wait for active processing to complete
    while (this.activeProcessing.size > 0) {
      pceLogger.debug("Waiting for active processing to complete", {
        activeCount: this.activeProcessing.size,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    pceLogger.info("Queue consumer stopped");
  }

  /**
   * Poll queue for new items
   */
  private async poll(): Promise<void> {
    if (!this.running) {
      return;
    }

    try {
      // Process items up to concurrency limit
      while (
        this.activeProcessing.size < this.options.concurrency &&
        this.running
      ) {
        const item = await this.queue.dequeue();
        if (!item) {
          break; // No items available
        }

        // Process asynchronously
        this.processItem(item).catch((error) => {
          pceLogger.error(`Failed to process queue item`, {
            queueId: item.id,
            error: error.message,
          });
        });
      }
    } catch (error: any) {
      pceLogger.error(`Queue polling error`, { error: error.message });
    }

    // Schedule next poll
    if (this.running) {
      this.pollTimer = setTimeout(() => this.poll(), this.options.pollInterval);
    }
  }

  /**
   * Process a single queue item
   */
  private async processItem(item: QueueItem): Promise<void> {
    const startTime = Date.now();
    this.activeProcessing.add(item.id);

    try {
      pceLogger.info(`Processing queue item`, {
        queueId: item.id,
        eventType: item.payload.eventType,
      });

      // Handle delete events
      if (item.payload.eventType === "delete") {
        // TODO: Implement delete handling
        pceLogger.warn("Delete events not yet implemented", { queueId: item.id });
        await this.queue.complete(item.id);
        return;
      }

      // Get document content
      let documentContent: string;
      let documentPath: string;

      if (item.payload.documentContent) {
        documentContent = item.payload.documentContent;
        documentPath = item.payload.documentPath || `/tmp/webhook-${item.id}.txt`;
        // Write to temp file if needed
        if (!item.payload.documentPath) {
          await fs.writeFile(documentPath, documentContent, "utf-8");
        }
      } else if (item.payload.documentPath) {
        documentPath = item.payload.documentPath;
        documentContent = await fs.readFile(documentPath, "utf-8");
      } else {
        throw new Error("No document content or path provided");
      }

      // Process through ingestion pipeline
      const ingestionResult = await this.ingestionPipeline.ingestFile(
        documentPath,
        {
          documentType: item.payload.documentType as DocumentType,
          aclGroup: item.payload.aclGroup as ACLGroup,
          redact: true,
          reindex: item.payload.eventType === "update",
        }
      );

      // Process through graph pipeline if available
      if (this.graphPipeline) {
        await this.graphPipeline.ingestFile(documentPath, {
          documentType: item.payload.documentType as DocumentType,
          aclGroup: item.payload.aclGroup as ACLGroup,
          redact: true,
          reindex: item.payload.eventType === "update",
        });
      }

      // Mark as completed
      await this.queue.complete(item.id);

      const latency = Date.now() - startTime;
      pceLogger.info(`Queue item processed successfully`, {
        queueId: item.id,
        status: ingestionResult.status,
        chunksIndexed: ingestionResult.chunksIndexed,
        latencyMs: latency,
      });

      // Log metrics if enabled
      if (this.options.enableMetrics) {
        pceLogger.incrementCounter("ingestion_success_count");
        pceLogger.debug("Ingestion latency", {
          latencyMs: latency,
          queueId: item.id,
        });
      }
    } catch (error: any) {
      const latency = Date.now() - startTime;
      pceLogger.error(`Queue item processing failed`, {
        queueId: item.id,
        error: error.message,
        latencyMs: latency,
      });

      // Try to retry
      const willRetry = await this.queue.fail(item.id, error.message);
      if (!willRetry) {
        if (this.options.enableMetrics) {
          pceLogger.incrementCounter("ingestion_failure_count");
        }
      }
    } finally {
      this.activeProcessing.delete(item.id);
    }
  }

  /**
   * Get consumer statistics
   */
  getStats(): {
    running: boolean;
    activeProcessing: number;
    queueStats: ReturnType<RealtimeIngestionQueue["getStats"]>;
  } {
    return {
      running: this.running,
      activeProcessing: this.activeProcessing.size,
      queueStats: this.queue.getStats(),
    };
  }
}

