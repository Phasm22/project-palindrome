#!/usr/bin/env bun

import { $ } from "bun";
import { NetworkIngestionOrchestrator } from "../src/pce/ingestion/network-ingestion";
import { FirewallIngestionOrchestrator } from "../src/pce/ingestion/firewall-ingestion";
import { SwitchIngestionOrchestrator } from "../src/pce/ingestion/switch-ingestion";

async function main() {
  let networkOrchestrator: NetworkIngestionOrchestrator | null = null;
  let firewallOrchestrator: FirewallIngestionOrchestrator | null = null;
  let switchOrchestrator: SwitchIngestionOrchestrator | null = null;
  try {
    console.log("=== Running Proxmox ingestion ===");
    await $`bun run scripts/ingest-proxmox.ts`;
    console.log("\n=== Running Network ingestion ===");
    networkOrchestrator = new NetworkIngestionOrchestrator();
    await networkOrchestrator.ingestNetwork();
    console.log("\n=== Running Firewall ingestion ===");
    firewallOrchestrator = new FirewallIngestionOrchestrator();
    await firewallOrchestrator.ingestFirewall();
    console.log("\n=== Running Switch ingestion ===");
    switchOrchestrator = new SwitchIngestionOrchestrator();
    await switchOrchestrator.ingestSwitches();
    console.log("\n=== Running Topology ingestion ===");
    await $`bun run scripts/ingest-topology.ts`;
    console.log("\nIngest-all complete.");
  } catch (error: any) {
    console.error("ingest-all failed:", error?.message || error);
    process.exit(1);
  } finally {
    await networkOrchestrator?.dispose?.();
    await firewallOrchestrator?.dispose?.();
    await switchOrchestrator?.dispose?.();
  }
}

main();

