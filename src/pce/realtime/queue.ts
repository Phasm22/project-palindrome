/**
 * Real-Time Ingestion Queue
 * Task 12.1: Define Real-Time Ingestion Queue
 * Durable queue for webhook events and immediate processing
 */

import { pceLogger } from "../utils/logger";

export interface QueueItem {
  id: string;
  timestamp: Date;
  payload: WebhookPayload;
  retries: number;
  status: "pending" | "processing" | "completed" | "failed";
  error?: string;
}

export interface WebhookPayload {
  documentPath?: string;
  documentContent?: string;
  documentType: string;
  aclGroup: string;
  eventType: "create" | "update" | "delete";
  metadata?: Record<string, any>;
}

/**
 * In-memory queue implementation
 * TODO: Replace with Redis/RabbitMQ for production durability
 */
export class RealtimeIngestionQueue {
  private queue: QueueItem[] = [];
  private processing: Set<string> = new Set();
  private maxRetries: number = 3;
  private maxQueueSize: number = 1000;

  /**
   * Enqueue a webhook event for processing
   */
  async enqueue(payload: WebhookPayload): Promise<string> {
    if (this.queue.length >= this.maxQueueSize) {
      throw new Error("Queue is full, cannot enqueue new item");
    }

    const item: QueueItem = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      payload,
      retries: 0,
      status: "pending",
    };

    this.queue.push(item);
    pceLogger.info(`Enqueued webhook event`, {
      queueId: item.id,
      eventType: payload.eventType,
      queueSize: this.queue.length,
    });

    return item.id;
  }

  /**
   * Dequeue next item for processing
   */
  async dequeue(): Promise<QueueItem | null> {
    const item = this.queue.find((q) => q.status === "pending" && !this.processing.has(q.id));

    if (!item) {
      return null;
    }

    item.status = "processing";
    this.processing.add(item.id);

    pceLogger.debug(`Dequeued item for processing`, {
      queueId: item.id,
      queueSize: this.queue.length,
    });

    return item;
  }

  /**
   * Mark item as completed
   */
  async complete(queueId: string): Promise<void> {
    const item = this.queue.find((q) => q.id === queueId);
    if (item) {
      item.status = "completed";
      this.processing.delete(queueId);
      // Remove completed items after a delay (keep for metrics)
      setTimeout(() => {
        const index = this.queue.findIndex((q) => q.id === queueId);
        if (index !== -1) {
          this.queue.splice(index, 1);
        }
      }, 60000); // Keep for 1 minute
    }
  }

  /**
   * Mark item as failed and retry if possible
   */
  async fail(queueId: string, error: string): Promise<boolean> {
    const item = this.queue.find((q) => q.id === queueId);
    if (!item) {
      return false;
    }

    item.retries++;
    item.error = error;
    this.processing.delete(queueId);

    if (item.retries >= this.maxRetries) {
      item.status = "failed";
      pceLogger.error(`Queue item failed after ${item.retries} retries`, {
        queueId,
        error,
      });
      return false; // No more retries
    }

    // Retry: reset to pending
    item.status = "pending";
    item.error = undefined;
    pceLogger.warn(`Queue item will be retried`, {
      queueId,
      retries: item.retries,
      maxRetries: this.maxRetries,
    });

    return true; // Will retry
  }

  /**
   * Get queue statistics
   */
  getStats(): {
    total: number;
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  } {
    return {
      total: this.queue.length,
      pending: this.queue.filter((q) => q.status === "pending").length,
      processing: this.queue.filter((q) => q.status === "processing").length,
      completed: this.queue.filter((q) => q.status === "completed").length,
      failed: this.queue.filter((q) => q.status === "failed").length,
    };
  }

  /**
   * Get all items (for monitoring)
   */
  getAllItems(): QueueItem[] {
    return [...this.queue];
  }

  /**
   * Clear queue (for testing)
   */
  clear(): void {
    this.queue = [];
    this.processing.clear();
  }
}

