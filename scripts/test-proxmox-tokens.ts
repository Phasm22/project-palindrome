#!/usr/bin/env bun
/**
 * Consolidated Proxmox Token Test Script
 * 
 * Tests all Proxmox nodes (proxBig, yin, YANG) using the same env var logic
 * as the actual codebase (create-vm.ts, terraform-runner.ts, etc.)
 * 
 * This replaces:
 * - test-yin-cluster-resources.ts
 * - test-proxmox-nodes.ts
 * - test-yin-token.sh
 * - test-yang-token.sh
 * - test-terraform-token.sh
 */

// Load .env file first (environment variables take precedence if already set)
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Get project root (parent of scripts/ directory)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const envPath = join(projectRoot, ".env");

if (existsSync(envPath)) {
  try {
    const envFile = readFileSync(envPath, "utf-8");
    envFile.split("\n").forEach((line) => {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (trimmed && !trimmed.startsWith("#")) {
        const match = trimmed.match(/^([^#=]+)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          // Remove quotes if present
          let value = match[2].trim().replace(/^["']|["']$/g, "");
          // Don't override if already set (environment variables take precedence)
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    });
  } catch (e: any) {
    console.warn(`Warning: Could not load .env file: ${e.message}`);
  }
} else {
  // Also try current working directory as fallback
  const cwdEnvPath = join(process.cwd(), ".env");
  if (existsSync(cwdEnvPath) && cwdEnvPath !== envPath) {
    try {
      const envFile = readFileSync(cwdEnvPath, "utf-8");
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
      // Silent fallback
    }
  }
}

import { ProxmoxClient } from "../src/tools/proxmox/client";
import { resolveCredentialsForUrl } from "../src/tools/proxmox/config";

interface NodeConfig {
  name: string;
  url: string;
  tokenId: string;
  tokenSecret: string;
  source: string; // Which env vars were used
}

interface TestResult {
  node: string;
  success: boolean;
  tests: {
    version?: boolean;
    nodes?: boolean;
    clusterResources?: boolean;
    nodeStatus?: boolean;
  };
  errors: string[];
  info: Record<string, any>;
}

/**
 * Get node configuration using the same credential-pair resolution as runtime tools.
 */
function getNodeConfig(nodeName: string): NodeConfig | null {
  const nodeLower = nodeName.toLowerCase();
  
  let url: string | undefined;
  const sources: string[] = [`node=${nodeName}`];
  
  if (nodeLower === "yin" || nodeLower === "yang") {
    url = nodeLower === "yin"
      ? process.env.PROXMOX_YIN_URL || process.env.PROXMOX_URL
      : process.env.PROXMOX_YANG_URL || process.env.PROXMOX_URL;
    sources.push(nodeLower === "yin" ? "url=PROXMOX_YIN_URL||PROXMOX_URL" : "url=PROXMOX_YANG_URL||PROXMOX_URL");
  } else {
    url = process.env.PROXBIG_URL || process.env.PROXMOX_URL;
    sources.push("url=PROXBIG_URL||PROXMOX_URL");
  }
  
  if (url) {
    url = url.replace(/https?:\/\/([^\/:]+)/i, (match, hostname) => match.replace(hostname, hostname.toLowerCase()));
    url = url.replace(/\/api2\/json\/?$/, "");
  }

  const credentials = url ? resolveCredentialsForUrl(url) : null;
  if (credentials) {
    sources.push(`credentials=${credentials.source}`);
  }
  
  if (!url || !credentials) {
    return null;
  }
  
  return {
    name: nodeName,
    url,
    tokenId: credentials.tokenId,
    tokenSecret: credentials.tokenSecret,
    source: sources.join(", "),
  };
}

async function testNode(nodeName: string): Promise<TestResult> {
  const result: TestResult = {
    node: nodeName,
    success: false,
    tests: {},
    errors: [],
    info: {},
  };
  
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing Node: ${nodeName}`);
  console.log(`${"=".repeat(60)}`);
  
  const config = getNodeConfig(nodeName);
  if (!config) {
    result.errors.push("Missing required environment variables");
    console.log(`❌ Missing configuration`);
    console.log(`   Check environment variables for ${nodeName}`);
    return result;
  }
  
  console.log(`\nConfiguration:`);
  console.log(`  URL: ${config.url}`);
  console.log(`  Token ID: ${config.tokenId}`);
  console.log(`  Token Secret: ${config.tokenSecret ? `✅ Set (${config.tokenSecret.length} chars)` : "❌ Missing"}`);
  console.log(`  Source: ${config.source}`);
  
  const client = new ProxmoxClient({
    url: config.url,
    tokenId: config.tokenId,
    tokenSecret: config.tokenSecret,
    verifySsl: process.env.PROXMOX_VERIFY_SSL !== "false",
  });
  
  // Test 1: Version endpoint
  console.log(`\n1. Testing /version endpoint...`);
  try {
    const versionResult = await client.get("/version");
    result.tests.version = true;
    result.info.version = versionResult.data?.data || versionResult.data;
    console.log(`   ✅ Success: ${JSON.stringify(result.info.version)}`);
  } catch (error: any) {
    result.tests.version = false;
    const errorMsg = `Failed: ${error.message} (Status: ${error.response?.status})`;
    result.errors.push(errorMsg);
    console.log(`   ❌ ${errorMsg}`);
    return result; // Can't continue if auth fails
  }
  
  // Test 2: List nodes
  console.log(`\n2. Testing /nodes endpoint...`);
  try {
    const nodesResult = await client.get("/nodes");
    const nodes = nodesResult.data?.data || [];
    result.tests.nodes = true;
    result.info.nodes = nodes.map((n: any) => n.node).filter(Boolean);
    console.log(`   ✅ Success: Found ${result.info.nodes.length} node(s): ${result.info.nodes.join(", ")}`);
  } catch (error: any) {
    result.tests.nodes = false;
    const errorMsg = `Failed: ${error.message} (Status: ${error.response?.status})`;
    result.errors.push(errorMsg);
    console.log(`   ⚠️  ${errorMsg}`);
    if (error.response?.status === 401) {
      console.log(`   💡 401 Unauthorized - token may not have permissions or secret is wrong`);
    }
  }
  
  // Test 3: Cluster resources (for cluster nodes) or node status (for standalone)
  if (nodeName.toLowerCase() === "yin" || nodeName.toLowerCase() === "yang") {
    console.log(`\n3. Testing /cluster/resources endpoint...`);
    try {
      const resourcesResult = await client.get("/cluster/resources");
      const resources = resourcesResult.data?.data || [];
      const vms = resources.filter((r: any) => r.type === "qemu" || r.type === "lxc");
      result.tests.clusterResources = true;
      result.info.resources = resources.length;
      result.info.vms = vms.length;
      result.info.sampleVmIds = vms.slice(0, 10).map((v: any) => v.vmid);
      console.log(`   ✅ Success: Found ${result.info.resources} resource(s), ${result.info.vms} VM(s)`);
      console.log(`   Sample VM IDs: ${result.info.sampleVmIds.join(", ")}`);
    } catch (error: any) {
      result.tests.clusterResources = false;
      const errorMsg = `Failed: ${error.message} (Status: ${error.response?.status})`;
      result.errors.push(errorMsg);
      console.log(`   ❌ ${errorMsg}`);
      if (error.response?.status === 401) {
        console.log(`   💡 401 Unauthorized - token needs Datastore.Audit or Sys.Audit permission`);
      } else if (error.response?.status === 403) {
        console.log(`   💡 403 Forbidden - token doesn't have cluster-level read permissions`);
      }
    }
  } else {
    console.log(`\n3. Testing /nodes/${nodeName}/status endpoint...`);
    try {
      const statusResult = await client.get(`/nodes/${nodeName}/status`);
      result.tests.nodeStatus = true;
      result.info.status = statusResult.data?.data || {};
      console.log(`   ✅ Success: Node status retrieved`);
      console.log(`   Status: ${result.info.status.status || "unknown"}`);
      console.log(`   CPU: ${result.info.status.cpu || "N/A"}%`);
      console.log(`   Memory: ${result.info.status.mem ? `${(result.info.status.mem / 1024 / 1024 / 1024).toFixed(2)} GB` : "N/A"}`);
    } catch (error: any) {
      result.tests.nodeStatus = false;
      const errorMsg = `Failed: ${error.message} (Status: ${error.response?.status})`;
      result.errors.push(errorMsg);
      console.log(`   ⚠️  ${errorMsg}`);
      if (error.response?.status === 403) {
        console.log(`   💡 403 Forbidden - token may not have access to this node`);
      }
    }
  }
  
  // Determine overall success
  // Critical: version must pass (authentication)
  // At least one of: nodes, clusterResources, or nodeStatus must pass
  const criticalPassed = result.tests.version === true;
  const hasDataAccess = result.tests.nodes === true || result.tests.clusterResources === true || result.tests.nodeStatus === true;
  result.success = criticalPassed && hasDataAccess;
  
  if (result.success) {
    console.log(`\n✅ All critical tests passed for ${nodeName}!`);
  } else {
    if (!criticalPassed) {
      console.log(`\n❌ Critical test failed: Authentication (version endpoint)`);
    } else if (!hasDataAccess) {
      console.log(`\n❌ Critical test failed: No data access (nodes/clusterResources/nodeStatus)`);
    } else {
      console.log(`\n⚠️  Some tests failed for ${nodeName}`);
    }
  }
  
  return result;
}

async function main() {
  console.log("=".repeat(60));
  console.log("Proxmox Token Test Suite (Consolidated)");
  console.log("=".repeat(60));
  console.log("\nThis script tests all Proxmox nodes using the same env var logic");
  console.log("as the codebase (create-vm.ts, terraform-runner.ts, etc.)\n");
  
  // Test all nodes
  const nodes = ["proxBig", "yin", "YANG"];
  const results: TestResult[] = [];
  
  for (const node of nodes) {
    const result = await testNode(node);
    results.push(result);
  }
  
  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("Test Summary");
  console.log(`${"=".repeat(60)}`);
  
  for (const result of results) {
    const icon = result.success ? "✅" : "❌";
    console.log(`\n${icon} ${result.node}: ${result.success ? "SUCCESS" : "FAILED"}`);
    
    // Show passed tests
    const passedTests: string[] = [];
    if (result.tests.version) passedTests.push("Version (auth)");
    if (result.tests.nodes) passedTests.push("Nodes");
    if (result.tests.clusterResources) passedTests.push("Cluster resources");
    if (result.tests.nodeStatus) passedTests.push("Node status");
    
    if (passedTests.length > 0) {
      console.log(`   Passed: ${passedTests.join(", ")}`);
    }
    
    // Show failed tests
    const failedTests: string[] = [];
    if (result.tests.version === false) failedTests.push("Version (auth) - CRITICAL");
    if (result.tests.nodes === false && result.node.toLowerCase() !== "yang") failedTests.push("Nodes");
    if (result.tests.clusterResources === false && (result.node.toLowerCase() === "yin" || result.node.toLowerCase() === "yang")) failedTests.push("Cluster resources");
    if (result.tests.nodeStatus === false && result.node.toLowerCase() === "proxbig") failedTests.push("Node status");
    
    if (failedTests.length > 0) {
      console.log(`   Failed: ${failedTests.join(", ")}`);
    }
    
    // Show errors with context
    if (result.errors.length > 0) {
      result.errors.forEach(err => {
        // Extract HTTP status code if present
        const statusMatch = err.match(/Status: (\d+)/);
        if (statusMatch) {
          const status = statusMatch[1];
          if (status === "401") {
            console.log(`   ⚠️  ${err}`);
            console.log(`      → Token secret may be incorrect or token expired`);
          } else if (status === "403") {
            console.log(`   ⚠️  ${err}`);
            console.log(`      → Token lacks required permissions (non-critical)`);
          } else {
            console.log(`   ❌ ${err}`);
          }
        } else {
          console.log(`   ❌ ${err}`);
        }
      });
    }
  }
  
  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Total: ${successCount} succeeded, ${failCount} failed`);
  
  if (failCount > 0) {
    console.log(`\n💡 Troubleshooting:`);
    console.log(`   1. Check environment variables match the expected names`);
    console.log(`   2. Verify tokens have proper permissions`);
    console.log(`   3. Check network connectivity to each node`);
    console.log(`   4. For SSL issues, set PROXMOX_VERIFY_SSL=false`);
    console.log(`   5. For 401 errors: Token secret may be incorrect or token expired`);
    console.log(`\n   See docs/TROUBLESHOOTING.md for more help`);
    console.log(`\n⚠️  Note: Some nodes failed, but this may be expected if tokens differ per node`);
    process.exit(1);
  } else {
    console.log(`\n✅ All nodes tested successfully!`);
    process.exit(0);
  }
}

main().catch((error) => {
  console.error("\n❌ Fatal error:", error);
  process.exit(1);
});
