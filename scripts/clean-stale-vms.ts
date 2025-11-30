#!/usr/bin/env bun

/**
 * Clean stale VMs from Neo4j that no longer exist in Proxmox
 * 
 * This script:
 * 1. Queries Neo4j for all VMs
 * 2. Verifies each VM exists in Proxmox
 * 3. Deletes stale VMs from Neo4j
 */

import { TwinQueryService } from "../src/twin/api/twin-query-service";
import { pceLogger as logger } from "../src/pce/utils/logger";

async function main() {
  console.log("=".repeat(60));
  console.log("Cleaning Stale VMs from Neo4j");
  console.log("=".repeat(60));
  console.log();

  const twinQuery = new TwinQueryService();

  try {
    const result = await twinQuery.cleanStaleVms();
    
    console.log("✅ Cleanup complete!");
    console.log(`   Deleted: ${result.deleted} stale VM(s)`);
    if (result.errors > 0) {
      console.log(`   Errors: ${result.errors}`);
    }
    
    if (result.deleted === 0) {
      console.log("   No stale VMs found - Neo4j is in sync with Proxmox");
    }
  } catch (error: any) {
    console.error("❌ Error cleaning stale VMs:", error.message);
    process.exit(1);
  } finally {
    await twinQuery.close();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

