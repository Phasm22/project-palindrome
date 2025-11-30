#!/usr/bin/env bun

import { FirewallIngestionOrchestrator } from "../src/pce/ingestion/firewall-ingestion";

async function main() {
  const orchestrator = new FirewallIngestionOrchestrator();
  try {
    await orchestrator.ingestFirewall();
    console.log("Firewall ingestion completed successfully");
  } catch (error: any) {
    console.error("Firewall ingestion failed:", error?.message || error);
    process.exit(1);
  } finally {
    await orchestrator.dispose();
  }
}

main();

