#!/usr/bin/env bun
/**
 * Test Action Layer Environment Setup
 * 
 * Validates that all required environment variables are set for terraform operations.
 */

// Load .env file explicitly (Bun auto-loads, but ensure it's loaded for scripts)
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
          // Remove quotes if present and trim
          let value = match[2].trim().replace(/^["']|["']$/g, "");
          // Don't override if already set (environment takes precedence)
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

import { checkTerraformEnv, validateTerraformEnv } from "../src/actions/helpers/env-validator";

function main() {
  console.log("🔍 Checking Action Layer environment variables...\n");

  const validation = validateTerraformEnv();

  if (validation.valid) {
    console.log("✅ All required environment variables are set!\n");
    
    if (validation.warnings.length > 0) {
      console.log("⚠️  Warnings:");
      validation.warnings.forEach((warning) => {
        console.log(`   - ${warning}`);
      });
      console.log();
    }

    // Show what's configured
    console.log("📋 Configuration:");
    console.log(`   PROXMOX_URL: ${process.env.PROXMOX_URL || "NOT SET"}`);
    
    if (process.env.CLUSTER_TF_TOKEN_ID) {
      console.log(`   CLUSTER_TF_TOKEN_ID: ${process.env.CLUSTER_TF_TOKEN_ID}`);
      console.log(`   PROXMOX_CLUSTER_TF_SECRET: ${process.env.PROXMOX_CLUSTER_TF_SECRET ? "***SET***" : "NOT SET"}`);
    } else if (process.env.PROXBIG_TF_TOKEN_ID) {
      console.log(`   PROXBIG_TF_TOKEN_ID: ${process.env.PROXBIG_TF_TOKEN_ID}`);
      console.log(`   PROXMOX_PROXBIG_TF_SECRET: ${process.env.PROXMOX_PROXBIG_TF_SECRET ? "***SET***" : "NOT SET"}`);
    }
    
    if (process.env.SSH_PUBLIC_KEY) {
      console.log(`   SSH_PUBLIC_KEY: ${process.env.SSH_PUBLIC_KEY.substring(0, 50)}...`);
    } else {
      console.log(`   SSH_PUBLIC_KEY: NOT SET (terraform will try ~/.ssh/id_ed25519.pub)`);
    }
    
    console.log("\n✅ Environment is ready for terraform operations!");
    process.exit(0);
  } else {
    console.log("❌ Missing required environment variables:\n");
    validation.missing.forEach((missing) => {
      console.log(`   - ${missing}`);
    });
    console.log("\n📝 Required environment variables:");
    console.log("   PROXMOX_URL - Proxmox API endpoint (e.g., https://yin.prox:8006)");
    console.log("   CLUSTER_TF_TOKEN_ID - Terraform token ID (e.g., llm@pve!llm-agent)");
    console.log("   PROXMOX_CLUSTER_TF_SECRET - Terraform token secret");
    console.log("   OR");
    console.log("   PROXBIG_TF_TOKEN_ID - Terraform token ID (fallback)");
    console.log("   PROXMOX_PROXBIG_TF_SECRET - Terraform token secret (fallback)");
    console.log("\n   SSH_PUBLIC_KEY - SSH public key (optional, terraform can read from file)");
    console.log("\n💡 Tip: Set these in your .env file or export them in your shell");
    process.exit(1);
  }
}

main();

