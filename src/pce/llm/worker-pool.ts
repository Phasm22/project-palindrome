/**
 * LLM Worker Pool
 * Task 14.1: Asynchronous LLM Processing Pool
 * Dedicated, rate-limited pool for all LLM API calls to prevent blocking
 */

import { pceLogger } from "../utils/logger";

export interface LLMTask<T> {
  id: string;
  type: "redaction" | "entity_extraction" | "synthesis" | "embedding";
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  retries: number;
  createdAt: Date;
}

export interface LLMWorkerPoolOptions {
  maxConcurrency?: number;
  rateLimitRPM?: number; // Requests per minute
  maxRetries?: number;
  retryDelayMs?: number;
}

/**
 * LLM Worker Pool for Async Processing
 */
export class LLMWorkerPool {
  private queue: LLMTask<any>[] = [];
  private active: Set<string> = new Set();
  private options: Required<LLMWorkerPoolOptions>;
  private rateLimiter: RateLimiter;
  private running: boolean = true;

  constructor(options: LLMWorkerPoolOptions = {}) {
    this.options = {
      maxConcurrency: options.maxConcurrency || 5,
      rateLimitRPM: options.rateLimitRPM || 60,
      maxRetries: options.maxRetries || 3,
      retryDelayMs: options.retryDelayMs || 1000,
    };

    this.rateLimiter = new RateLimiter(this.options.rateLimitRPM);
    
    // Start processing loop
    this.processQueue();
  }

  /**
   * Submit a task to the worker pool
   */
  async submit<T>(
    type: LLMTask<T>["type"],
    execute: () => Promise<T>
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: LLMTask<T> = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type,
        execute,
        resolve,
        reject,
        retries: 0,
        createdAt: new Date(),
      };

      this.queue.push(task);
      pceLogger.debug(`LLM task queued`, {
        taskId: task.id,
        type,
        queueSize: this.queue.length,
      });
    });
  }

  /**
   * Process queue items
   */
  private async processQueue(): Promise<void> {
    while (this.running) {
      // Check if we can process more tasks
      if (
        this.active.size < this.options.maxConcurrency &&
        this.queue.length > 0
      ) {
        const task = this.queue.shift();
        if (task) {
          this.processTask(task).catch((error) => {
            pceLogger.error(`Task processing error`, {
              taskId: task.id,
              error: error.message,
            });
          });
        }
      }

      // Small delay to prevent busy waiting
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * Process a single task
   */
  private async processTask<T>(task: LLMTask<T>): Promise<void> {
    this.active.add(task.id);

    try {
      // Wait for rate limiter
      await this.rateLimiter.wait();

      // Execute task
      const startTime = Date.now();
      const result = await task.execute();
      const duration = Date.now() - startTime;

      pceLogger.debug(`LLM task completed`, {
        taskId: task.id,
        type: task.type,
        durationMs: duration,
      });

      task.resolve(result);
    } catch (error: any) {
      pceLogger.warn(`LLM task failed`, {
        taskId: task.id,
        type: task.type,
        error: error.message,
        retries: task.retries,
      });

      // Retry if possible
      if (task.retries < this.options.maxRetries) {
        task.retries++;
        
        // Exponential backoff
        const delay = this.options.retryDelayMs * Math.pow(2, task.retries - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));

        // Re-queue for retry
        this.queue.push(task);
        pceLogger.debug(`LLM task requeued for retry`, {
          taskId: task.id,
          retries: task.retries,
        });
      } else {
        // Max retries exceeded
        pceLogger.error(`LLM task failed after max retries`, {
          taskId: task.id,
          type: task.type,
          retries: task.retries,
        });
        task.reject(error);
      }
    } finally {
      this.active.delete(task.id);
    }
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    queueSize: number;
    activeTasks: number;
    maxConcurrency: number;
    rateLimitRPM: number;
  } {
    return {
      queueSize: this.queue.length,
      activeTasks: this.active.size,
      maxConcurrency: this.options.maxConcurrency,
      rateLimitRPM: this.options.rateLimitRPM,
    };
  }

  /**
   * Shutdown the worker pool
   */
  async shutdown(): Promise<void> {
    this.running = false;
    
    // Wait for active tasks to complete
    while (this.active.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Reject remaining queued tasks
    for (const task of this.queue) {
      task.reject(new Error("Worker pool shutdown"));
    }
    this.queue = [];

    pceLogger.info("LLM worker pool shutdown complete");
  }
}

/**
 * Simple rate limiter
 */
class RateLimiter {
  private requests: number[] = [];
  private rpm: number;

  constructor(rpm: number) {
    this.rpm = rpm;
  }

  async wait(): Promise<void> {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Remove old requests
    this.requests = this.requests.filter((time) => time > oneMinuteAgo);

    // Check if we're at the limit
    if (this.requests.length >= this.rpm) {
      // Wait until the oldest request expires
      const oldestRequest = this.requests[0];
      const waitTime = 60000 - (now - oldestRequest) + 100; // Add 100ms buffer
      
      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        return this.wait(); // Recursively check again
      }
    }

    // Record this request
    this.requests.push(Date.now());
  }
}

