#!/usr/bin/env bun

import { SwitchIngestionOrchestrator, pceLogger } from "../src/pce";

async function main() {
  let orchestrator: SwitchIngestionOrchestrator | null = null;
  try {
    pceLogger.info("Starting switch ingestion");
    orchestrator = new SwitchIngestionOrchestrator();
    const result = await orchestrator.ingestSwitches();
    pceLogger.info("Switch ingestion completed successfully", result);
  } catch (error: any) {
    pceLogger.error("Switch ingestion failed", { error: error.message });
    console.error("Switch ingestion failed:", error.message);
    process.exit(1);
  } finally {
    await orchestrator?.dispose?.();
  }
}

main();
