#!/usr/bin/env bun
/**
 * Test Create VM Action (Dry-Run)
 * 
 * Tests the create-vm action without actually creating a VM.
 */

// Load .env file explicitly
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  try {
    const envFile = readFileSync(envPath, "utf-8");
    envFile.split("\n").forEach((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const match = trimmed.match(/^([^#=]+)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          let value = match[2].trim().replace(/^["']|["']$/g, "");
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    });
  } catch (e: any) {
    console.warn(`Warning: Could not load .env file: ${e.message}`);
  }
}

import { createVm } from "../src/actions/compute/create-vm";
import { checkTerraformEnv } from "../src/actions/helpers/env-validator";

async function main() {
  console.log("🧪 Testing Create VM Action (Dry-Run)\n");

  // Validate environment first
  if (!checkTerraformEnv()) {
    console.error("❌ Environment validation failed. Run: bun scripts/test-action-env.ts");
    process.exit(1);
  }

  console.log("✅ Environment validated\n");

  // Test create-vm with dry-run
  console.log("📋 Test Parameters:");
  console.log("   name: test-vm");
  console.log("   node: proxBig");
  console.log("   cores: 1");
  console.log("   memory: 1024 MB");
  console.log("   diskSize: 8G");
  console.log("   dryRun: true\n");

  try {
    const result = await createVm({
      name: "test-vm",
      node: "proxBig",
      cores: 1,
      memory: 1024,
      diskSize: "8G",
      dryRun: true,
    });

    console.log("📊 Result:");
    console.log(`   Success: ${result.success}`);
    console.log(`   Message: ${result.message}`);

    if (result.success) {
      console.log("\n✅ Dry-run successful! The action would create the VM.");
      console.log("\n💡 To create a real VM, set dryRun: false");
    } else {
      console.log("\n❌ Dry-run failed. Check the error message above.");
      process.exit(1);
    }
  } catch (error: any) {
    console.error("\n❌ Error executing create-vm action:");
    console.error(`   ${error.message}`);
    if (error.stack) {
      console.error("\nStack trace:");
      console.error(error.stack);
    }
    process.exit(1);
  } finally {
    // Force exit to close any hanging connections
    process.exit(0);
  }
}

main();

