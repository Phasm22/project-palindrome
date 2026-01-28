#!/usr/bin/env bun

/**
 * Clean stale nodes from the digital twin
 * 
 * This script:
 * 1. Detects nodes that no longer exist in source systems (Proxmox, OPNsense)
 * 2. Removes stale nodes from the digital twin
 * 3. Supports dry-run mode for testing
 */

import { StaleNodeCleaner } from "../src/twin/cleanup/stale-node-cleaner";
import { pceLogger as logger } from "../src/pce/utils/logger";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run") || args.includes("-d");
  const maxAgeMinutes = args.find(arg => arg.startsWith("--max-age="))?.split("=")[1] 
    ? parseInt(args.find(arg => arg.startsWith("--max-age="))!.split("=")[1], 10)
    : 10;

  console.log("=".repeat(60));
  console.log("Cleaning Stale Nodes from Digital Twin");
  console.log("=".repeat(60));
  console.log();
  
  if (dryRun) {
    console.log("⚠️  DRY RUN MODE - No nodes will be deleted");
    console.log();
  }
  
  console.log(`Max age threshold: ${maxAgeMinutes} minutes`);
  console.log();

  const cleaner = new StaleNodeCleaner(undefined, { maxAgeMinutes });

  try {
    const results = await cleaner.cleanAll({ dryRun, maxAgeMinutes });
    
    console.log();
    console.log("=".repeat(60));
    console.log("Cleanup Results");
    console.log("=".repeat(60));
    console.log();
    
    let totalDeleted = 0;
    let totalErrors = 0;
    
    for (const result of results) {
      console.log(`${result.entityType}:`);
      console.log(`  Deleted: ${result.deleted}`);
      console.log(`  Errors: ${result.errors}`);
      if (result.details.length > 0) {
        console.log(`  Details:`);
        result.details.forEach(detail => console.log(`    - ${detail}`));
      }
      console.log();
      
      totalDeleted += result.deleted;
      totalErrors += result.errors;
    }
    
    console.log("=".repeat(60));
    console.log(`Total: ${totalDeleted} deleted, ${totalErrors} errors`);
    console.log("=".repeat(60));
    
    if (totalDeleted === 0 && totalErrors === 0) {
      console.log("✅ No stale nodes found - digital twin is in sync!");
    } else if (totalErrors === 0) {
      console.log(`✅ Cleanup complete! Removed ${totalDeleted} stale node(s)`);
    } else {
      console.log(`⚠️  Cleanup completed with ${totalErrors} error(s)`);
      process.exit(1);
    }
  } catch (error: any) {
    console.error("❌ Error cleaning stale nodes:", error.message);
    logger.error("Stale node cleanup failed", { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
