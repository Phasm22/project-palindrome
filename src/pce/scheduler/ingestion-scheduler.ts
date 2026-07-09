import { NetworkIngestionOrchestrator } from "../ingestion/network-ingestion";
import { FirewallIngestionOrchestrator } from "../ingestion/firewall-ingestion";
import { pceLogger as logger } from "../utils/logger";
import { MetricsCollector } from "../metrics/collector";
import { StaleNodeCleaner } from "../../twin/cleanup/stale-node-cleaner";
import { $ } from "bun";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Scheduled Ingestion Service
 * 
 * Runs periodic ingestion to keep the digital twin and vector store up to date.
 * Currently runs full ingestion every 5 minutes.
 */
export interface IngestionRunDetails {
  timestamp: Date;
  duration: number;
  success: boolean;
  proxmox: {
    success: boolean;
    duration: number;
    error?: string;
  };
  network: {
    success: boolean;
    duration: number;
    entities?: number;
    relationships?: number;
    error?: string;
  };
  firewall: {
    success: boolean;
    duration: number;
    entities?: number;
    relationships?: number;
    error?: string;
  };
  cleanup: {
    duration: number;
    deleted: number;
    error?: string;
  };
  temperature?: {
    nodesWithTemp: number;
    nodesWithoutTemp: number;
  };
}

export class IngestionScheduler {
  private interval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastRun: Date | null = null;
  private lastRunDetails: IngestionRunDetails | null = null;
  private runHistory: IngestionRunDetails[] = [];
  private maxHistorySize = 20; // Keep last 20 runs
  private intervalMs: number;
  private metricsCollector: MetricsCollector;
  private runCount = 0;
  private successCount = 0;
  private failureCount = 0;
  private readonly runEventLogPath = `${process.cwd()}/.pce-dashboard/ingestion-runs.ndjson`;

  constructor(intervalMinutes: number = 5, metricsCollector?: MetricsCollector) {
    this.intervalMs = intervalMinutes * 60 * 1000;
    this.metricsCollector = metricsCollector || new MetricsCollector();
  }

  /**
   * Start the scheduler
   */
  start() {
    if (process.env.PCE_INGESTION_ENABLED !== "1") {
      logger.info("Ingestion scheduler disabled (set PCE_INGESTION_ENABLED=1 to enable)");
      return;
    }
    if (this.interval) {
      logger.warn("Ingestion scheduler already running");
      return;
    }

    logger.info("Starting ingestion scheduler", {
      intervalMinutes: this.intervalMs / 60000,
    });

    // Run immediately on start (don't wait for first interval)
    this.runIngestion();

    // Then schedule periodic runs
    this.interval = setInterval(() => {
      this.runIngestion();
    }, this.intervalMs);
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info("Ingestion scheduler stopped");
    }
  }

  /**
   * Check if scheduler is running
   */
  isActive(): boolean {
    return this.interval !== null;
  }

  /**
   * Get last run time
   */
  getLastRun(): Date | null {
    return this.lastRun;
  }

  /**
   * Get last run details
   */
  getLastRunDetails(): IngestionRunDetails | null {
    return this.lastRunDetails;
  }

  /**
   * Get run history
   */
  getRunHistory(limit: number = 10): IngestionRunDetails[] {
    return this.runHistory.slice(-limit);
  }

  /**
   * Check if currently running
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Run full ingestion (Proxmox + Network + Firewall)
   */
  private async runIngestion() {
    // Prevent concurrent runs
    if (this.isRunning) {
      logger.warn("Ingestion already running, skipping this cycle");
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    this.runCount++;
    const runId = `ing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    this.emitJobEvent("job.started", {
      job: "ingestion_scheduler",
      run_id: runId,
      interval_minutes: this.intervalMs / 60000,
    });

    let proxmoxSuccess = false;
    let networkSuccess = false;
    let firewallSuccess = false;
    let proxmoxDuration = 0;
    let networkDuration = 0;
    let firewallDuration = 0;
    let proxmoxError: string | undefined;
    let networkError: string | undefined;
    let networkEntities = 0;
    let networkRelationships = 0;
    let firewallError: string | undefined;
    let firewallEntities = 0;
    let firewallRelationships = 0;
    let temperatureStats: { nodesWithTemp: number; nodesWithoutTemp: number } | undefined;

    try {
      logger.info("Starting scheduled ingestion");

      // Run Proxmox ingestion
      const proxmoxStart = Date.now();
      try {
        logger.info("Running Proxmox ingestion...");
        const result = await $`bun run scripts/ingest-proxmox.ts`.quiet();
        proxmoxDuration = Date.now() - proxmoxStart;
        proxmoxSuccess = true;
        logger.info("Proxmox ingestion completed");
        this.metricsCollector.record("ingestion_scheduler_proxmox_duration_ms", proxmoxDuration, { status: "success" });
        this.metricsCollector.record("ingestion_scheduler_proxmox_success", 1);
        
        // Try to extract temperature stats from logs (if available)
        // This is a best-effort - we'll track it better in future iterations
      } catch (error: any) {
        proxmoxDuration = Date.now() - proxmoxStart;
        proxmoxError = error.message || String(error);
        if (error.stderr) {
          const stderrStr = error.stderr.toString();
          if (stderrStr.length < 500) {
            proxmoxError = stderrStr;
          } else {
            proxmoxError = `${error.message} (see logs for details)`;
          }
        }
        logger.error("Proxmox ingestion failed", {
          error: proxmoxError,
        });
        this.metricsCollector.record("ingestion_scheduler_proxmox_duration_ms", proxmoxDuration, { status: "failure" });
        this.metricsCollector.record("ingestion_scheduler_proxmox_failure", 1);
      }

      // Run Network ingestion
      const networkStart = Date.now();
      let networkOrchestrator: NetworkIngestionOrchestrator | null = null;
      try {
        logger.info("Running Network ingestion...");
        networkOrchestrator = new NetworkIngestionOrchestrator();
        await networkOrchestrator.ingestNetwork();
        networkDuration = Date.now() - networkStart;
        networkSuccess = true;
        // Note: Network ingestion doesn't return counts, but we can track from logs
        logger.info("Network ingestion completed");
        this.metricsCollector.record("ingestion_scheduler_network_duration_ms", networkDuration, { status: "success" });
        this.metricsCollector.record("ingestion_scheduler_network_success", 1);
      } catch (error: any) {
        networkDuration = Date.now() - networkStart;
        networkError = error.message || String(error);
        logger.error("Network ingestion failed", { error: networkError });
        this.metricsCollector.record("ingestion_scheduler_network_duration_ms", networkDuration, { status: "failure" });
        this.metricsCollector.record("ingestion_scheduler_network_failure", 1);
      } finally {
        await networkOrchestrator?.dispose?.();
      }

      // Run Firewall ingestion
      const firewallStart = Date.now();
      let firewallOrchestrator: FirewallIngestionOrchestrator | null = null;
      try {
        logger.info("Running Firewall ingestion...");
        firewallOrchestrator = new FirewallIngestionOrchestrator();
        await firewallOrchestrator.ingestFirewall();
        firewallDuration = Date.now() - firewallStart;
        firewallSuccess = true;
        // Note: Firewall ingestion doesn't return counts, but we can track from logs
        logger.info("Firewall ingestion completed");
        this.metricsCollector.record("ingestion_scheduler_firewall_duration_ms", firewallDuration, { status: "success" });
        this.metricsCollector.record("ingestion_scheduler_firewall_success", 1);
      } catch (error: any) {
        firewallDuration = Date.now() - firewallStart;
        firewallError = error.message || String(error);
        logger.error("Firewall ingestion failed", { error: firewallError });
        this.metricsCollector.record("ingestion_scheduler_firewall_duration_ms", firewallDuration, { status: "failure" });
        this.metricsCollector.record("ingestion_scheduler_firewall_failure", 1);
      } finally {
        await firewallOrchestrator?.dispose?.();
      }

      const duration = Date.now() - startTime;
      this.lastRun = new Date();
      
      // Step 4: Clean stale nodes after ingestion
      const cleanupStart = Date.now();
      let cleanupDeleted = 0;
      let cleanupError: string | undefined;
      try {
        logger.info("Running stale node cleanup...");
        const cleaner = new StaleNodeCleaner();
        const cleanupResults = await cleaner.cleanAll({ maxAgeMinutes: 10 });
        const cleanupDuration = Date.now() - cleanupStart;
        
        cleanupDeleted = cleanupResults.reduce((sum, r) => sum + r.deleted, 0);
        if (cleanupDeleted > 0) {
          logger.info("Stale node cleanup completed", {
            durationMs: cleanupDuration,
            deleted: cleanupDeleted,
            results: cleanupResults.map(r => ({ type: r.entityType, deleted: r.deleted })),
          });
          this.metricsCollector.record("ingestion_scheduler_cleanup_deleted", cleanupDeleted);
        } else {
          logger.debug("No stale nodes found during cleanup");
        }
        this.metricsCollector.record("ingestion_scheduler_cleanup_duration_ms", cleanupDuration);
      } catch (error: any) {
        cleanupError = error.message || String(error);
        logger.warn("Stale node cleanup failed", { error: cleanupError });
        // Don't fail ingestion if cleanup fails
      }

      // Record overall metrics
      const overallSuccess = proxmoxSuccess && networkSuccess && firewallSuccess;
      if (overallSuccess) {
        this.successCount++;
        this.metricsCollector.record("ingestion_scheduler_run_success", 1);
      } else {
        this.failureCount++;
        this.metricsCollector.record("ingestion_scheduler_run_failure", 1);
      }
      
      this.metricsCollector.record("ingestion_scheduler_run_duration_ms", duration);
      this.metricsCollector.record("ingestion_scheduler_run_count", this.runCount);
      this.metricsCollector.record("ingestion_scheduler_success_count", this.successCount);
      this.metricsCollector.record("ingestion_scheduler_failure_count", this.failureCount);

      // Store run details
      const runDetails: IngestionRunDetails = {
        timestamp: this.lastRun,
        duration,
        success: overallSuccess,
        proxmox: {
          success: proxmoxSuccess,
          duration: proxmoxDuration,
          error: proxmoxError,
        },
        network: {
          success: networkSuccess,
          duration: networkDuration,
          entities: networkEntities,
          relationships: networkRelationships,
          error: networkError,
        },
        firewall: {
          success: firewallSuccess,
          duration: firewallDuration,
          entities: firewallEntities,
          relationships: firewallRelationships,
          error: firewallError,
        },
        cleanup: {
          duration: Date.now() - cleanupStart,
          deleted: cleanupDeleted,
          error: cleanupError,
        },
        temperature: temperatureStats,
      };

      this.lastRunDetails = runDetails;
      this.runHistory.push(runDetails);
      
      // Keep only last N runs
      if (this.runHistory.length > this.maxHistorySize) {
        this.runHistory.shift();
      }

      logger.info("Scheduled ingestion completed", {
        durationMs: duration,
        proxmoxDuration,
        networkDuration,
        firewallDuration,
        success: overallSuccess,
        lastRun: this.lastRun.toISOString(),
      });
      this.emitJobEvent("job.completed", {
        job: "ingestion_scheduler",
        run_id: runId,
        success: overallSuccess,
        duration_ms: duration,
        timestamp: this.lastRun.toISOString(),
        proxmox: runDetails.proxmox,
        network: runDetails.network,
        firewall: runDetails.firewall,
        cleanup: runDetails.cleanup,
      });
      this.appendRunEvent({
        ts: new Date().toISOString(),
        event: "job.completed",
        run_id: runId,
        details: runDetails,
      });
    } catch (error: any) {
      this.failureCount++;
      this.metricsCollector.record("ingestion_scheduler_run_failure", 1);
      logger.error("Scheduled ingestion failed", {
        error: error.message,
        stack: error.stack,
      });
      this.emitJobEvent("job.failed", {
        job: "ingestion_scheduler",
        run_id: runId,
        error: error.message,
      });
    } finally {
      this.isRunning = false;
    }
  }

  private emitJobEvent(event: string, fields: Record<string, unknown>) {
    logger.info(JSON.stringify({
      ts: new Date().toISOString(),
      event,
      service: "pce-api",
      ...fields,
    }));
  }

  private appendRunEvent(payload: Record<string, unknown>) {
    const dir = dirname(this.runEventLogPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(this.runEventLogPath, `${JSON.stringify(payload)}\n`, "utf8");
  }

  /**
   * Manually trigger ingestion (useful for testing or on-demand runs)
   */
  async triggerNow() {
    if (this.isRunning) {
      logger.warn("Ingestion already running, cannot trigger now");
      return;
    }
    await this.runIngestion();
  }
}
