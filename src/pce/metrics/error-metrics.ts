/**
 * Error Rate and Retries Metrics
 * Task 13.3: Error Rate and Retries Logging
 */

import { MetricsCollector } from "./collector";
import { pceLogger } from "../utils/logger";

export interface ErrorContext {
  errorType: string;
  isTransient: boolean;
  retryAttempt?: number;
  service?: string; // e.g., "llm", "vector_db", "graph_db"
}

/**
 * Error metrics tracking
 */
export class ErrorMetrics {
  private collector: MetricsCollector;

  constructor(collector: MetricsCollector) {
    this.collector = collector;
  }

  /**
   * Record an error
   */
  recordError(context: ErrorContext): void {
    // Increment error counter
    pceLogger.incrementCounter("error_count_total");
    
    this.collector.record("error_count", 1, {
      errorType: context.errorType,
      isTransient: context.isTransient.toString(),
      service: context.service || "unknown",
    });

    // Track non-transient errors separately
    if (!context.isTransient) {
      pceLogger.incrementCounter("error_count_non_transient");
      this.collector.record("error_count_non_transient", 1, {
        errorType: context.errorType,
        service: context.service || "unknown",
      });
    }

    // Track retry attempts
    if (context.retryAttempt !== undefined) {
      this.collector.record("error_retry_attempt", context.retryAttempt, {
        errorType: context.errorType,
        service: context.service || "unknown",
      });
    }
  }

  /**
   * Record retry success/failure
   */
  recordRetryOutcome(success: boolean, retryAttempt: number, errorType: string): void {
    if (success) {
      pceLogger.incrementCounter("retry_success_count");
      this.collector.record("retry_success", 1, {
        errorType,
        retryAttempt: retryAttempt.toString(),
      });
    } else {
      pceLogger.incrementCounter("retry_failure_count");
      this.collector.record("retry_failure", 1, {
        errorType,
        retryAttempt: retryAttempt.toString(),
      });
    }
  }

  /**
   * Record exponential backoff effectiveness
   */
  recordBackoff(delayMs: number, attempt: number, success: boolean): void {
    this.collector.record("backoff_delay_ms", delayMs, {
      attempt: attempt.toString(),
      success: success.toString(),
    });
  }

  /**
   * Check if error is transient (e.g., rate limits, network errors)
   */
  isTransientError(error: any): boolean {
    const errorMessage = error?.message?.toLowerCase() || "";
    const errorCode = error?.code || error?.status || "";

    // Common transient error patterns
    const transientPatterns = [
      "rate limit",
      "too many requests",
      "429",
      "503",
      "502",
      "504",
      "timeout",
      "network",
      "connection",
      "econnrefused",
      "etimedout",
    ];

    return (
      transientPatterns.some((pattern) =>
        errorMessage.includes(pattern) || errorCode.toString().includes(pattern)
      ) || false
    );
  }
}

