#!/usr/bin/env bun

import { NetworkIngestionOrchestrator, pceLogger } from "../src/pce";

async function main() {
  let orchestrator: NetworkIngestionOrchestrator | null = null;
  try {
    pceLogger.info("Starting network ingestion");
    orchestrator = new NetworkIngestionOrchestrator();
    await orchestrator.ingestNetwork();
    pceLogger.info("Network ingestion completed successfully");
  } catch (error: any) {
    pceLogger.error("Network ingestion failed", { error: error.message });
    console.error("Network ingestion failed:", error.message);
    process.exit(1);
  } finally {
    await orchestrator?.dispose?.();
  }
}

main();

