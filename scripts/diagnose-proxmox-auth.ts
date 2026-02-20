#!/usr/bin/env bun
/**
 * Diagnostic script to verify Proxmox API authentication
 * Tests the Authorization header format and which secret is being used
 */

import { ProxmoxClient } from "../src/tools/proxmox/client";
import { ProxmoxReadOnlyTool } from "../src/tools/proxmox/readonly/proxmox-readonly-tool";
import { getPrimaryProxmoxConfig, resolveCredentialsForUrl } from "../src/tools/proxmox/config";

async function diagnoseAuth() {
  console.log("=".repeat(60));
  console.log("Proxmox Authentication Diagnostic");
  console.log("=".repeat(60));

  const url = process.env.PROXMOX_URL;
  const resolvedPrimary = getPrimaryProxmoxConfig();
  const resolvedForUrl = url ? resolveCredentialsForUrl(url) : null;
  const tokenId = resolvedPrimary?.tokenId;
  const tokenSecret = resolvedPrimary?.tokenSecret;

  console.log(`\nEnvironment Variables:`);
  console.log(`  PROXMOX_URL: ${url || "❌ Not set"}`);
  console.log(`  PROXMOX_TOKEN_ID: ${process.env.PROXMOX_TOKEN_ID || "❌ Not set"}`);
  console.log(`  PROXMOX_TOKEN_SECRET: ${process.env.PROXMOX_TOKEN_SECRET ? `✅ Set (${process.env.PROXMOX_TOKEN_SECRET.length} chars)` : "❌ Not set"}`);
  console.log(`  PROXBIG_TOKEN_SECRET: ${process.env.PROXBIG_TOKEN_SECRET ? `✅ Set (${process.env.PROXBIG_TOKEN_SECRET.length} chars)` : "❌ Not set"}`);
  console.log(`  PROXBIG_TF_SECRET: ${process.env.PROXBIG_TF_SECRET ? `✅ Set (${process.env.PROXBIG_TF_SECRET.length} chars)` : "❌ Not set"}`);
  console.log(`  CLUSTER_TF_TOKEN_ID: ${process.env.CLUSTER_TF_TOKEN_ID || "❌ Not set"}`);
  console.log(`  PROXMOX_CLUSTER_TF_SECRET: ${process.env.PROXMOX_CLUSTER_TF_SECRET ? `✅ Set (${process.env.PROXMOX_CLUSTER_TF_SECRET.length} chars)` : "❌ Not set"}`);

  if (!url || !tokenId || !tokenSecret) {
    console.error("\n❌ Missing required environment variables or no complete token-id/secret pair found");
    process.exit(1);
  }

  let nodeName: string | null = null;
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    nodeName = hostname.split(".")[0].toUpperCase();
    console.log(`\nNode Detection:`);
    console.log(`  URL hostname: ${hostname}`);
    console.log(`  Extracted node name: ${nodeName}`);
  } catch (error) {
    console.error(`\n⚠️  Failed to parse URL: ${error}`);
  }

  console.log(`\nCredential Selection:`);
  console.log(`  Resolved source: ${resolvedPrimary.credentialSource || "unknown"}`);
  console.log(`  Token ID: ${tokenId}`);
  console.log(`  Secret length: ${tokenSecret.length} chars`);
  console.log(`  Secret prefix: ${tokenSecret.substring(0, 4)}...`);
  if (resolvedForUrl) {
    console.log(`  URL-scoped source: ${resolvedForUrl.source}`);
  }

  // Expected Authorization header format
  const expectedHeader = `PVEAPIToken=${tokenId}=${tokenSecret}`;
  console.log(`\nAuthorization Header Format:`);
  console.log(`  Expected: PVEAPIToken=<tokenId>=<secret>`);
  console.log(`  Actual:   PVEAPIToken=${tokenId}=${tokenSecret.substring(0, 4)}...`);
  console.log(`  Full length: ${expectedHeader.length} chars`);

  // Test 1: Direct client test
  console.log(`\n${"=".repeat(60)}`);
  console.log("Test 1: Direct ProxmoxClient");
  console.log(`${"=".repeat(60)}`);
  try {
    const client = new ProxmoxClient({
      url,
      tokenId,
      tokenSecret,
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
  console.log(`\nResolved credential source: ${resolvedPrimary.credentialSource || "unknown"}`);
}

diagnoseAuth().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
