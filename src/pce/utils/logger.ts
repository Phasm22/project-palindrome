/**
 * PCE Enhanced Logging Utility
 * Task 0.1: Minimal Logging Setup with hash comparison and document status visibility
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

class PCELogger {
  private level: LogLevel;

  constructor(level: LogLevel = LogLevel.INFO) {
    this.level = level;
  }

  setLevel(level: LogLevel) {
    this.level = level;
  }

  private formatMessage(level: string, message: string, meta?: Record<string, any>): string {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
    return `[${timestamp}] [${level}] ${message}${metaStr}`;
  }

  debug(message: string, meta?: Record<string, any>) {
    if (this.level <= LogLevel.DEBUG) {
      console.debug(this.formatMessage("DEBUG", message, meta));
    }
  }

  info(message: string, meta?: Record<string, any>) {
    if (this.level <= LogLevel.INFO) {
      console.log(this.formatMessage("INFO", message, meta));
    }
  }

  warn(message: string, meta?: Record<string, any>) {
    if (this.level <= LogLevel.WARN) {
      console.warn(this.formatMessage("WARN", message, meta));
    }
  }

  error(message: string, meta?: Record<string, any>) {
    if (this.level <= LogLevel.ERROR) {
      console.error(this.formatMessage("ERROR", message, meta));
    }
  }

  // Specialized logging for DLM operations
  logHashComparison(filePath: string, oldHash: string | null, newHash: string, status: "NEW" | "MODIFIED" | "UNCHANGED") {
    this.info(`Hash comparison for ${filePath}`, {
      oldHash: oldHash || "none",
      newHash,
      status,
    });
  }

  logDocumentStatusChange(filePath: string, oldStatus: string | null, newStatus: string) {
    this.info(`Document status changed: ${filePath}`, {
      oldStatus: oldStatus || "none",
      newStatus,
    });
  }
}

export const pceLogger = new PCELogger(
  process.env.PCE_LOG_LEVEL === "DEBUG" ? LogLevel.DEBUG : LogLevel.INFO
);

