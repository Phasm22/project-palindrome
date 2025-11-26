#!/usr/bin/env bun

import { $ } from "bun";
import { NetworkIngestionOrchestrator } from "../src/pce";

async function main() {
  let networkOrchestrator: NetworkIngestionOrchestrator | null = null;
  try {
    console.log("=== Running Proxmox ingestion ===");
    await $`bun run scripts/ingest-proxmox.ts`;
    console.log("\n=== Running Network ingestion ===");
    networkOrchestrator = new NetworkIngestionOrchestrator();
    await networkOrchestrator.ingestNetwork();
    console.log("\nIngest-all complete.");
  } catch (error: any) {
    console.error("ingest-all failed:", error?.message || error);
    process.exit(1);
  } finally {
    await networkOrchestrator?.dispose?.();
  }
}

main();

