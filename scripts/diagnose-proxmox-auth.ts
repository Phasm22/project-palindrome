#!/usr/bin/env bun
/**
 * Diagnostic script to verify Proxmox API authentication
 * Tests the Authorization header format and which secret is being used
 */

import { ProxmoxClient } from "../src/tools/proxmox/client";
import { ProxmoxReadOnlyTool } from "../src/tools/proxmox/readonly/proxmox-readonly-tool";

async function diagnoseAuth() {
  console.log("=".repeat(60));
  console.log("Proxmox Authentication Diagnostic");
  console.log("=".repeat(60));

  const url = process.env.PROXMOX_URL;
  const tokenId = process.env.PROXMOX_TOKEN_ID;
  const defaultSecret = process.env.PROXMOX_TOKEN_SECRET;

  console.log(`\nEnvironment Variables:`);
  console.log(`  PROXMOX_URL: ${url || "❌ Not set"}`);
  console.log(`  PROXMOX_TOKEN_ID: ${tokenId || "❌ Not set"}`);
  console.log(`  PROXMOX_TOKEN_SECRET: ${defaultSecret ? `✅ Set (${defaultSecret.length} chars)` : "❌ Not set"}`);

  if (!url || !tokenId || !defaultSecret) {
    console.error("\n❌ Missing required environment variables");
    process.exit(1);
  }

  // Extract node name from URL
  let nodeName: string | null = null;
  let nodeSpecificSecret: string | undefined;
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    nodeName = hostname.split('.')[0].toUpperCase();
    nodeSpecificSecret = process.env[`${nodeName}_TOKEN_SECRET`];
    console.log(`\nNode Detection:`);
    console.log(`  URL hostname: ${hostname}`);
    console.log(`  Extracted node name: ${nodeName}`);
    console.log(`  ${nodeName}_TOKEN_SECRET: ${nodeSpecificSecret ? `✅ Set (${nodeSpecificSecret.length} chars)` : "⚠️  Not set"}`);
  } catch (error) {
    console.error(`\n⚠️  Failed to parse URL: ${error}`);
  }

  const secretToUse = nodeSpecificSecret || defaultSecret;
  console.log(`\nSecret Selection:`);
  console.log(`  Using: ${nodeSpecificSecret ? `${nodeName}_TOKEN_SECRET` : "PROXMOX_TOKEN_SECRET"}`);
  console.log(`  Secret length: ${secretToUse.length} chars`);
  console.log(`  Secret prefix: ${secretToUse.substring(0, 4)}...`);

  // Expected Authorization header format
  const expectedHeader = `PVEAPIToken=${tokenId}=${secretToUse}`;
  console.log(`\nAuthorization Header Format:`);
  console.log(`  Expected: PVEAPIToken=<tokenId>=<secret>`);
  console.log(`  Actual:   PVEAPIToken=${tokenId}=${secretToUse.substring(0, 4)}...`);
  console.log(`  Full length: ${expectedHeader.length} chars`);

  // Test 1: Direct client test
  console.log(`\n${"=".repeat(60)}`);
  console.log("Test 1: Direct ProxmoxClient");
  console.log(`${"=".repeat(60)}`);
  try {
    const client = new ProxmoxClient({
      url,
      tokenId,
      tokenSecret: secretToUse,
      verifySsl: process.env.PROXMOX_VERIFY_SSL !== "false",
    });

    const result = await client.get("/version");
    console.log(`✅ Direct client test: SUCCESS`);
    console.log(`   Version: ${JSON.stringify(result.data)}`);
  } catch (error: any) {
    console.log(`❌ Direct client test: FAILED`);
    console.log(`   Error: ${error.message}`);
    console.log(`   Status: ${error.response?.status}`);
    if (error.response?.status === 401) {
      console.log(`   💡 401 = Authentication failed (wrong token/secret)`);
    }
  }

  // Test 2: Tool integration test
  console.log(`\n${"=".repeat(60)}`);
  console.log("Test 2: Tool Integration (getApiConfig)");
  console.log(`${"=".repeat(60)}`);
  try {
    const tool = new ProxmoxReadOnlyTool();
    const result = await tool.execute(
      { action: "list_nodes" },
      { toolName: "proxmox_readonly" }
    );

    if (result.error) {
      console.log(`❌ Tool integration test: FAILED`);
      console.log(`   Error: ${result.error}`);
      if (result.error.includes("401") || result.error.includes("authentication")) {
        console.log(`   💡 401 = Authentication failed (wrong token/secret)`);
        console.log(`   💡 Check if getApiConfig() is using the correct secret`);
      }
    } else {
      console.log(`✅ Tool integration test: SUCCESS`);
      const nodeCount = result.data?.nodes?.length || result.data?.count || 0;
      console.log(`   Nodes found: ${nodeCount}`);
    }
  } catch (error: any) {
    console.log(`❌ Tool integration test: FAILED`);
    console.log(`   Error: ${error.message}`);
    if (error.message.includes("401") || error.message.includes("authentication")) {
      console.log(`   💡 401 = Authentication failed (wrong token/secret)`);
    }
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("Diagnostic Summary");
  console.log(`${"=".repeat(60)}`);
  console.log(`Token ID format: ${tokenId}`);
  console.log(`   Expected: user@realm!tokenid`);
  console.log(`   Has @: ${tokenId.includes("@") ? "✅" : "❌"}`);
  console.log(`   Has !: ${tokenId.includes("!") ? "✅" : "❌"}`);
  console.log(`\nSecret being used: ${nodeSpecificSecret ? `${nodeName}_TOKEN_SECRET (node-specific)` : "PROXMOX_TOKEN_SECRET (default)"}`);
  if (nodeName && !nodeSpecificSecret) {
    console.log(`\n⚠️  WARNING: Node name detected (${nodeName}) but ${nodeName}_TOKEN_SECRET not set!`);
    console.log(`   If this node needs a different secret, set ${nodeName}_TOKEN_SECRET`);
  }
}

diagnoseAuth().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

