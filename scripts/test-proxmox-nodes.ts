#!/usr/bin/env bun
/**
 * Test script to verify Proxmox API connectivity for all 3 nodes
 * Tests: proxBig, yin, YANG
 * 
 * This script:
 * 1. Checks environment variables
 * 2. Tests each node's API connectivity
 * 3. Lists nodes from each cluster connection
 * 4. Verifies node status and resources
 */

import { ProxmoxClient } from "../src/tools/proxmox/client";
import { ProxmoxReadOnlyTool } from "../src/tools/proxmox/readonly/proxmox-readonly-tool";

// Node configurations - update these with your actual node URLs
// Note: Using hostnames instead of IPs so node-specific secret lookup works correctly
const NODES = [
  { name: "proxBig", url: "https://proxBig.prox:8006", ip: "172.16.0.10", fallbackUrl: "https://172.16.0.10:8006" },
  { name: "yin", url: "https://yin.prox:8006", ip: "172.16.0.11", fallbackUrl: "https://172.16.0.11:8006" },
  { name: "YANG", url: "https://yang.prox:8006", ip: "172.16.0.12", fallbackUrl: "https://172.16.0.12:8006" },
];

interface TestResult {
  node: string;
  success: boolean;
  error?: string;
  nodesFound?: string[];
  nodeStatus?: any;
}

async function testNode(nodeConfig: typeof NODES[0]): Promise<TestResult> {
  const { name, url, ip, fallbackUrl } = nodeConfig;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing Node: ${name} (${ip})`);
  console.log(`URL: ${url}`);
  console.log(`${"=".repeat(60)}`);

  try {
    // Check for node-specific environment variables
    const nodeNameUpper = name.toUpperCase();
    const tokenId = process.env.PROXMOX_TOKEN_ID;
    // IMPORTANT: Use node-specific secret if available, otherwise fall back to default
    // This matches the logic in getApiConfig() which extracts node name from URL hostname
    const nodeSpecificSecret = process.env[`${nodeNameUpper}_TOKEN_SECRET`];
    const defaultSecret = process.env.PROXMOX_TOKEN_SECRET;
    const tokenSecret = nodeSpecificSecret || defaultSecret;
    const verifySsl = process.env.PROXMOX_VERIFY_SSL !== "false";

    console.log(`\nEnvironment Variables:`);
    console.log(`  PROXMOX_TOKEN_ID: ${tokenId ? "✅ Set" : "❌ Missing"}`);
    console.log(`  PROXMOX_TOKEN_SECRET: ${defaultSecret ? "✅ Set (default)" : "❌ Missing"}`);
    console.log(`  ${nodeNameUpper}_TOKEN_SECRET: ${nodeSpecificSecret ? "✅ Set (node-specific)" : "⚠️  Not set (using default)"}`);
    console.log(`  Using secret: ${nodeSpecificSecret ? `${nodeNameUpper}_TOKEN_SECRET` : "PROXMOX_TOKEN_SECRET"}`);
    console.log(`  PROXMOX_VERIFY_SSL: ${verifySsl ? "true (default)" : "false"}`);

    if (!tokenId || !tokenSecret) {
      return {
        node: name,
        success: false,
        error: `Missing credentials: PROXMOX_TOKEN_ID=${!!tokenId}, ${nodeNameUpper}_TOKEN_SECRET or PROXMOX_TOKEN_SECRET=${!!tokenSecret}`,
      };
    }

    // Try hostname URL first (for proper node-specific secret lookup)
    // If that fails, try IP address as fallback
    let testUrl = url;
    let client = new ProxmoxClient({
      url: testUrl,
      tokenId,
      tokenSecret,
      verifySsl,
    });

    console.log(`\n1. Testing API Connection...`);
    try {
      // Test basic API connectivity
      const versionResult = await client.get("/version");
      console.log(`   ✅ API Connection successful`);
      console.log(`   Version: ${JSON.stringify(versionResult.data)}`);
    } catch (error: any) {
      return {
        node: name,
        success: false,
        error: `API connection failed: ${error.message} (Status: ${error.response?.status})`,
      };
    }

    console.log(`\n2. Listing Nodes in Cluster...`);
    let nodesFound: string[] = [];
    try {
      const nodesResult = await client.get("/nodes");
      const nodes = nodesResult.data?.data || [];
      nodesFound = nodes.map((n: any) => n.node).filter(Boolean);
      console.log(`   ✅ Found ${nodesFound.length} node(s): ${nodesFound.join(", ")}`);
    } catch (error: any) {
      console.log(`   ⚠️  Failed to list nodes: ${error.message} (Status: ${error.response?.status})`);
    }

    console.log(`\n3. Testing Node Status for "${name}"...`);
    let nodeStatus: any = null;
    try {
      // Try to get status for this specific node
      const statusResult = await client.get(`/nodes/${name}/status`);
      nodeStatus = statusResult.data?.data || {};
      console.log(`   ✅ Node status retrieved`);
      console.log(`   Status: ${nodeStatus.status || "unknown"}`);
      console.log(`   CPU: ${nodeStatus.cpu || "N/A"}%`);
      console.log(`   Memory: ${nodeStatus.mem ? `${(nodeStatus.mem / 1024 / 1024 / 1024).toFixed(2)} GB` : "N/A"}`);
      console.log(`   Max Memory: ${nodeStatus.maxmem ? `${(nodeStatus.maxmem / 1024 / 1024 / 1024).toFixed(2)} GB` : "N/A"}`);
      console.log(`   Uptime: ${nodeStatus.uptime ? `${(nodeStatus.uptime / 3600).toFixed(2)} hours` : "N/A"}`);
    } catch (error: any) {
      console.log(`   ⚠️  Failed to get node status: ${error.message} (Status: ${error.response?.status})`);
      if (error.response?.status === 403) {
        console.log(`   ⚠️  Permission denied - token may not have access to this node`);
      }
    }

    console.log(`\n4. Testing Tool Integration...`);
    try {
      // Temporarily set PROXMOX_URL for this node
      // CRITICAL: Use hostname URL (not IP) so node-specific secret lookup works correctly
      // The getApiConfig() method extracts node name from URL hostname
      const originalUrl = process.env.PROXMOX_URL;
      process.env.PROXMOX_URL = url; // Use hostname URL, not IP
      
      const tool = new ProxmoxReadOnlyTool();
      const result = await tool.execute(
        { action: "list_nodes" },
        { toolName: "proxmox_readonly" }
      );

      // Restore original URL
      process.env.PROXMOX_URL = originalUrl;

      if (result.error) {
        console.log(`   ⚠️  Tool execution error: ${result.error}`);
        // Check if it's a 401 - likely wrong secret being used
        if (result.error.includes("401") || result.error.includes("authentication")) {
          console.log(`   💡 Tip: 401 error suggests wrong token secret. Check if ${nodeNameUpper}_TOKEN_SECRET is set correctly.`);
        }
      } else {
        console.log(`   ✅ Tool integration successful`);
        const nodeCount = result.data?.nodes?.length || result.data?.count || 0;
        console.log(`   Nodes via tool: ${nodeCount}`);
      }
    } catch (error: any) {
      console.log(`   ⚠️  Tool integration error: ${error.message}`);
      if (error.message.includes("401") || error.message.includes("authentication")) {
        console.log(`   💡 Tip: 401 error suggests wrong token secret. Check if ${nodeNameUpper}_TOKEN_SECRET is set correctly.`);
      }
    }

    return {
      node: name,
      success: true,
      nodesFound,
      nodeStatus,
    };
  } catch (error: any) {
    return {
      node: name,
      success: false,
      error: `Unexpected error: ${error.message}`,
    };
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("Proxmox API Node Test Suite");
  console.log("=".repeat(60));
  console.log(`\nTesting ${NODES.length} nodes: ${NODES.map(n => n.name).join(", ")}`);

  // Check global environment variables
  console.log(`\n${"=".repeat(60)}`);
  console.log("Global Environment Variables:");
  console.log(`${"=".repeat(60)}`);
  console.log(`PROXMOX_URL: ${process.env.PROXMOX_URL || "❌ Not set"}`);
  console.log(`PROXMOX_TOKEN_ID: ${process.env.PROXMOX_TOKEN_ID || "❌ Not set"}`);
  console.log(`PROXMOX_TOKEN_SECRET: ${process.env.PROXMOX_TOKEN_SECRET ? "✅ Set" : "❌ Not set"}`);
  console.log(`PROXMOX_VERIFY_SSL: ${process.env.PROXMOX_VERIFY_SSL || "true (default)"}`);
  console.log(`\nNode-Specific Secrets:`);
  for (const node of NODES) {
    const nodeSecret = process.env[`${node.name.toUpperCase()}_TOKEN_SECRET`];
    console.log(`  ${node.name.toUpperCase()}_TOKEN_SECRET: ${nodeSecret ? "✅ Set" : "⚠️  Not set (will use PROXMOX_TOKEN_SECRET)"}`);
  }

  // Test each node
  const results: TestResult[] = [];
  for (const nodeConfig of NODES) {
    const result = await testNode(nodeConfig);
    results.push(result);
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("Test Summary");
  console.log(`${"=".repeat(60)}`);
  for (const result of results) {
    const icon = result.success ? "✅" : "❌";
    console.log(`${icon} ${result.node}: ${result.success ? "SUCCESS" : "FAILED"}`);
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
    if (result.nodesFound && result.nodesFound.length > 0) {
      console.log(`   Nodes found: ${result.nodesFound.join(", ")}`);
    }
  }

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  console.log(`\nTotal: ${successCount} succeeded, ${failCount} failed`);

  if (failCount > 0) {
    console.log(`\n⚠️  Some nodes failed. Check:`);
    console.log(`   1. Environment variables are set correctly`);
    console.log(`   2. API tokens have proper permissions`);
    console.log(`   3. Network connectivity to each node`);
    console.log(`   4. SSL certificates (try PROXMOX_VERIFY_SSL=false for self-signed)`);
    process.exit(1);
  } else {
    console.log(`\n✅ All nodes tested successfully!`);
    process.exit(0);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

