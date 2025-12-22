import { NetworkIngestionOrchestrator } from "../ingestion/network-ingestion";
import { FirewallIngestionOrchestrator } from "../ingestion/firewall-ingestion";
import { pceLogger as logger } from "../utils/logger";
import { MetricsCollector } from "../metrics/collector";
import { $ } from "bun";

/**
 * Scheduled Ingestion Service
 * 
 * Runs periodic ingestion to keep the digital twin and vector store up to date.
 * Currently runs full ingestion every 5 minutes.
 */
export class IngestionScheduler {
  private interval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastRun: Date | null = null;
  private intervalMs: number;
  private metricsCollector: MetricsCollector;
  private runCount = 0;
  private successCount = 0;
  private failureCount = 0;

  constructor(intervalMinutes: number = 5, metricsCollector?: MetricsCollector) {
    this.intervalMs = intervalMinutes * 60 * 1000;
    this.metricsCollector = metricsCollector || new MetricsCollector();
  }

  /**
   * Start the scheduler
   */
  start() {
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

    let proxmoxSuccess = false;
    let networkSuccess = false;
    let firewallSuccess = false;
    let proxmoxDuration = 0;
    let networkDuration = 0;
    let firewallDuration = 0;

    try {
      logger.info("Starting scheduled ingestion");

      // Run Proxmox ingestion
      const proxmoxStart = Date.now();
      try {
        logger.info("Running Proxmox ingestion...");
        await $`bun run scripts/ingest-proxmox.ts`.quiet();
        proxmoxDuration = Date.now() - proxmoxStart;
        proxmoxSuccess = true;
        logger.info("Proxmox ingestion completed");
        this.metricsCollector.record("ingestion_scheduler_proxmox_duration_ms", proxmoxDuration, { status: "success" });
        this.metricsCollector.record("ingestion_scheduler_proxmox_success", 1);
      } catch (error: any) {
        proxmoxDuration = Date.now() - proxmoxStart;
        logger.error("Proxmox ingestion failed", {
          error: error.message,
          stderr: error.stderr?.toString(),
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
        logger.info("Network ingestion completed");
        this.metricsCollector.record("ingestion_scheduler_network_duration_ms", networkDuration, { status: "success" });
        this.metricsCollector.record("ingestion_scheduler_network_success", 1);
      } catch (error: any) {
        networkDuration = Date.now() - networkStart;
        logger.error("Network ingestion failed", { error: error.message });
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
        logger.info("Firewall ingestion completed");
        this.metricsCollector.record("ingestion_scheduler_firewall_duration_ms", firewallDuration, { status: "success" });
        this.metricsCollector.record("ingestion_scheduler_firewall_success", 1);
      } catch (error: any) {
        firewallDuration = Date.now() - firewallStart;
        logger.error("Firewall ingestion failed", { error: error.message });
        this.metricsCollector.record("ingestion_scheduler_firewall_duration_ms", firewallDuration, { status: "failure" });
        this.metricsCollector.record("ingestion_scheduler_firewall_failure", 1);
      } finally {
        await firewallOrchestrator?.dispose?.();
      }

      const duration = Date.now() - startTime;
      this.lastRun = new Date();
      
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
      
      logger.info("Scheduled ingestion completed", {
        durationMs: duration,
        proxmoxDuration,
        networkDuration,
        firewallDuration,
        success: overallSuccess,
        lastRun: this.lastRun.toISOString(),
      });
    } catch (error: any) {
      this.failureCount++;
      this.metricsCollector.record("ingestion_scheduler_run_failure", 1);
      logger.error("Scheduled ingestion failed", {
        error: error.message,
        stack: error.stack,
      });
    } finally {
      this.isRunning = false;
    }
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

