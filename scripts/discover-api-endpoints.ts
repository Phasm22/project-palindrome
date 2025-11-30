#!/usr/bin/env bun

/**
 * API Endpoint Discovery Script
 * 
 * Automatically discovers all available API endpoints for registered services
 * and generates gap analysis reports.
 * 
 * Usage:
 *   bun run scripts/discover-api-endpoints.ts [--service=proxmox|opnsense|all]
 */

import { discoveryRegistry } from "../src/tools/api-discovery";
import { ProxmoxDiscoveryService } from "../src/tools/api-discovery/proxmox-discovery";
import { OpnsenseDiscoveryService } from "../src/tools/api-discovery/opnsense-discovery";
import { ProxmoxClient } from "../src/tools/proxmox/client";
import { writeFileSync } from "fs";
import { join } from "path";

interface GapAnalysis {
  service: string;
  discoveredEndpoints: number;
  enabledActions: number;
  missingEndpoints: Array<{
    path: string;
    method: string;
    category?: string;
    reason?: string;
  }>;
  enabledButNotDiscovered: Array<{
    action: string;
    reason?: string;
  }>;
}

/**
 * Get currently enabled actions from tool implementations
 */
function getEnabledActions(service: string): string[] {
  if (service === "proxmox") {
    // Read from ProxmoxReadOnlyParams enum
    return [
      "list_nodes",
      "node_status",
      "node_resources",
      "node_disks",
      "node_network_interfaces",
      "list_vms",
      "get_vm_status",
      "get_vm_config",
      "get_vm_network",
      "get_vm_snapshots",
      "get_vm_ip",
      "get_lxc_config",
      "cluster_resources",
      "cluster_status",
      "cluster_ceph_status",
      "ha_groups",
      "ha_resources",
    ];
  } else if (service === "opnsense") {
    // Read from OpnsenseReadOnlyParams enum
    return [
      "firewall_rules_list",
      "firewall_aliases_list",
      "firewall_aliases_get",
      "firewall_categories_list",
      "firewall_states_list",
      "interfaces_list",
      "interface_status",
      "interfaces_vlans_list",
      "interfaces_vips_list",
      "system_status",
      "system_health",
      "system_info",
      "system_backups_list",
      "diagnostics_arp_table",
      "diagnostics_routing_table",
      "diagnostics_interface_statistics",
      "diagnostics_system_logs",
      "dhcp_leases_list",
      "dhcp_status",
      "dhcp_static_mappings_list",
    ];
  }
  return [];
}

/**
 * Map Proxmox endpoint path to tool action name
 */
function mapProxmoxEndpointToAction(path: string, method: string): string {
  // Remove /api2/json prefix
  let cleanPath = path.replace(/^\/api2\/json\/?/, "").replace(/^\/api\/?/, "");
  
  // Normalize: remove leading slash for consistent matching
  if (cleanPath.startsWith("/")) {
    cleanPath = cleanPath.substring(1);
  }
  
  // Handle VM endpoints FIRST (before general node endpoints)
  // /nodes/{node}/qemu/{vmid}/status -> get_vm_status
  if (cleanPath.includes("/qemu/") || cleanPath.includes("/lxc/")) {
    if (cleanPath.includes("/agent/")) {
      if (cleanPath.includes("network-get-interfaces") || cleanPath.includes("network")) {
        return "get_vm_network";
      }
      if (cleanPath.includes("get-ip")) {
        return "get_vm_ip";
      }
    }
    
    const allParts = cleanPath.split("/").filter(p => p);
    const parts = allParts.filter(p => !p.startsWith("{"));
    const vmidIndex = parts.findIndex(p => p === "qemu" || p === "lxc");
    
    if (vmidIndex >= 0 && parts.length > vmidIndex + 1) {
      const vmType = parts[vmidIndex];
      const resource = parts[vmidIndex + 1];
      
      if (resource === "status") return "get_vm_status";
      if (resource === "config") return vmType === "lxc" ? "get_lxc_config" : "get_vm_config";
      if (resource === "snapshot" || cleanPath.includes("snapshot")) return "get_vm_snapshots";
      
      return `get_vm_${resource}`.replace(/-/g, "_");
    }
  }
  
  // Handle node-scoped endpoints: /nodes/{node}/status -> node_status
  if (cleanPath.startsWith("nodes/")) {
    // Split path but keep placeholders to understand structure
    const allParts = cleanPath.split("/").filter(p => p);
    // Filter out placeholders for resource extraction
    const parts = allParts.filter(p => !p.startsWith("{"));
    
    // Pattern: /nodes/{node}/resource -> node_resource
    // After filtering: ["nodes", "resource"]
    if (parts.length >= 2 && parts[0] === "nodes") {
      const resource = parts[1]; // nodes/{node}/status -> status (after filtering {node})
      
      // Special mappings
      if (resource === "status") return "node_status";
      if (resource === "qemu") return "list_vms";
      if (resource === "lxc") return "list_vms"; // LXC containers
      if (resource === "storage") return "node_storage";
      if (resource === "network") return "node_network_interfaces";
      if (resource === "resources") return "node_resources";
      if (resource === "services") return "node_services";
      if (resource === "tasks") return "node_tasks";
      
      // Generic: nodes/{node}/resource -> node_resource
      return `node_${resource}`.replace(/-/g, "_");
    }
    
    // Pattern: /nodes/{node}/resource/subresource
    // After filtering: ["nodes", "resource", "subresource"]
    if (parts.length >= 3 && parts[0] === "nodes") {
      const resource = parts[1];
      const subresource = parts[2];
      
      if (resource === "disks" && subresource === "list") return "node_disks";
      if (resource === "qemu" || resource === "lxc") {
        // /nodes/{node}/qemu/{vmid}/status -> get_vm_status
        // This will be handled by the VM endpoint section below
      }
      
      return `node_${resource}_${subresource}`.replace(/-/g, "_");
    }
  }
  
  // Handle cluster endpoints
  if (cleanPath.startsWith("cluster/")) {
    const parts = cleanPath.split("/").filter(p => p);
    if (parts[1] === "resources") return "cluster_resources";
    if (parts[1] === "status") return "cluster_status";
    if (parts[1] === "ceph" && parts[2] === "status") return "cluster_ceph_status";
    if (parts[1] === "ha" && parts[2] === "groups") return "ha_groups";
    if (parts[1] === "ha" && parts[2] === "resources") return "ha_resources";
  }
  
  // Handle VM endpoints: /nodes/{node}/qemu/{vmid}/status -> get_vm_status
  if (cleanPath.includes("/qemu/") || cleanPath.includes("/lxc/")) {
    // Check for agent endpoints first (they have a different structure)
    if (cleanPath.includes("/agent/")) {
      if (cleanPath.includes("network-get-interfaces") || cleanPath.includes("network")) {
        return "get_vm_network";
      }
      if (cleanPath.includes("get-ip")) {
        return "get_vm_ip";
      }
    }
    
    const allParts = cleanPath.split("/").filter(p => p);
    const parts = allParts.filter(p => !p.startsWith("{"));
    const vmidIndex = parts.findIndex(p => p === "qemu" || p === "lxc");
    
    // After filtering: /nodes/{node}/qemu/{vmid}/status -> ["nodes", "qemu", "status"]
    // vmidIndex = 1, so we need parts.length > vmidIndex + 1 to access parts[vmidIndex + 1] = "status"
    if (vmidIndex >= 0 && parts.length > vmidIndex + 1) {
      const vmType = parts[vmidIndex]; // qemu or lxc
      const resource = parts[vmidIndex + 1]; // After filtering: qemu/{vmid}/status -> status is at index vmidIndex+1
      
      if (resource === "status") return "get_vm_status";
      if (resource === "config") return vmType === "lxc" ? "get_lxc_config" : "get_vm_config";
      if (resource === "snapshot" || cleanPath.includes("snapshot")) return "get_vm_snapshots";
      
      return `get_vm_${resource}`.replace(/-/g, "_");
    }
  }
  
  // Handle /nodes endpoint (list nodes)
  if (cleanPath === "nodes" || cleanPath === "nodes/") return "list_nodes";
  
  // Fallback: generic mapping
  const parts = cleanPath.split("/").filter(p => p && !p.startsWith("{"));
  const resource = parts[parts.length - 1] || parts[0] || "unknown";
  const methodPrefix = method === "GET" ? "get" : method === "POST" ? "create" : "action";
  return `${methodPrefix}_${resource}`.replace(/-/g, "_");
}

/**
 * Map OPNsense endpoint path to tool action name
 */
function mapOpnsenseEndpointToAction(path: string, method: string): string {
  // Remove /api prefix
  let cleanPath = path.replace(/^\/api\/?/, "");
  const parts = cleanPath.split("/").filter(p => p);
  
  if (parts.length === 0) return "unknown";
  
  const module = parts[0]; // firewall, system, interfaces, etc.
  const action = parts[parts.length - 1];
  
  // Map to tool action names
  if (module === "firewall") {
    if (action === "searchItem" || action === "get") return "firewall_aliases_get";
    if (cleanPath.includes("alias/list") || cleanPath.includes("aliases")) return "firewall_aliases_list";
    if (cleanPath.includes("rule") && action === "search") return "firewall_rules_list";
    if (cleanPath.includes("category")) return "firewall_categories_list";
    if (cleanPath.includes("state")) return "firewall_states_list";
  }
  
  if (module === "system") {
    if (action === "systemStatus" || action === "status") return "system_status";
    if (action === "health") return "system_health";
    if (action === "info") return "system_info";
    if (cleanPath.includes("backup")) return "system_backups_list";
  }
  
  if (module === "interfaces") {
    if (action === "list") return "interfaces_list";
    if (action === "status") return "interface_status";
    if (cleanPath.includes("vlan")) return "interfaces_vlans_list";
    if (cleanPath.includes("vip")) return "interfaces_vips_list";
  }
  
  if (module === "diagnostics") {
    if (cleanPath.includes("getArp") || cleanPath.includes("arp")) return "diagnostics_arp_table";
    if (cleanPath.includes("getRoutes") || cleanPath.includes("routes")) return "diagnostics_routing_table";
    if (cleanPath.includes("statistics")) return "diagnostics_interface_statistics";
    if (cleanPath.includes("logs")) return "diagnostics_system_logs";
  }
  
  if (module === "dhcp" || module === "dhcpv4") {
    if (cleanPath.includes("searchLease") || cleanPath.includes("lease")) return "dhcp_leases_list";
    if (action === "status") return "dhcp_status";
    if (cleanPath.includes("static") || cleanPath.includes("mapping")) return "dhcp_static_mappings_list";
  }
  
  // Fallback
  return `${module}_${action}`.replace(/-/g, "_");
}

/**
 * Perform gap analysis
 */
function analyzeGaps(
  discoveryResult: any,
  enabledActions: string[]
): GapAnalysis {
  const discovered = discoveryResult.endpoints;
  
  // Map discovered endpoints to action names using proper mapping
  const discoveredActionMap = new Map<string, any>();
  discovered.forEach((e: any) => {
    let actionName: string;
    if (discoveryResult.service === "proxmox") {
      actionName = mapProxmoxEndpointToAction(e.path, e.method);
    } else if (discoveryResult.service === "opnsense") {
      actionName = mapOpnsenseEndpointToAction(e.path, e.method);
    } else {
      // Fallback
      const parts = e.path.replace(/^\/api[^\/]*\//, "").split("/");
      const resource = parts[parts.length - 1];
      actionName = `${e.method === "GET" ? "get" : "action"}_${resource}`.replace(/-/g, "_");
    }
    
    discoveredActionMap.set(actionName, e);
  });
  
  const discoveredActionNames = new Set(discoveredActionMap.keys());
  const enabledSet = new Set(enabledActions);
  
  // Find missing endpoints (discovered but not enabled)
  const missingEndpoints: Array<{path: string; method: string; category?: string; reason?: string}> = [];
  discoveredActionMap.forEach((endpoint, actionName) => {
    if (!enabledSet.has(actionName)) {
      missingEndpoints.push({
        path: endpoint.path,
        method: endpoint.method,
        category: endpoint.category,
        reason: `Discovered as "${actionName}" but not enabled in tool`,
      });
    }
  });

  // Find enabled actions that weren't discovered
  const enabledButNotDiscovered = enabledActions
    .filter(action => !discoveredActionNames.has(action))
    .map(action => ({
      action,
      reason: "Enabled in tool but not discovered (may require parameters or be deprecated)",
    }));

  return {
    service: discoveryResult.service,
    discoveredEndpoints: discovered.length,
    enabledActions: enabledActions.length,
    missingEndpoints,
    enabledButNotDiscovered,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const serviceFilter = args.find(a => a.startsWith("--service="))?.split("=")[1] || "all";

  console.log("🔍 Starting API endpoint discovery...\n");

  // Register discovery services
  if (serviceFilter === "proxmox" || serviceFilter === "all") {
    try {
      // Check for required environment variables (same logic as ProxmoxReadOnlyBase)
      const proxmoxUrl = process.env.PROXMOX_URL || process.env.PROXMOX_API_HOST;
      const tokenId = process.env.PROXMOX_TOKEN_ID || process.env.PROXMOX_API_TOKEN_ID;
      
      // Support node-specific token secrets (e.g., PROXBIG_TOKEN_SECRET) as fallback
      let tokenSecret = process.env.PROXMOX_TOKEN_SECRET || process.env.PROXMOX_API_TOKEN_SECRET;
      
      // Try to find node-specific token secret based on URL hostname (same as base classes)
      if (proxmoxUrl) {
        try {
          const urlObj = new URL(proxmoxUrl);
          const hostname = urlObj.hostname.toLowerCase();
          const nodeName = hostname.split('.')[0].toUpperCase();
          const nodeSpecificSecret = process.env[`${nodeName}_TOKEN_SECRET`];
          if (nodeSpecificSecret) {
            console.log(`📌 Using node-specific secret: ${nodeName}_TOKEN_SECRET`);
            tokenSecret = nodeSpecificSecret;
          }
        } catch {
          // URL parsing failed, use default
        }
      }

      if (!proxmoxUrl || !tokenId || !tokenSecret) {
        console.warn("⚠️  Proxmox discovery skipped: Missing required environment variables");
        console.warn("   Required: PROXMOX_URL (or PROXMOX_API_HOST), PROXMOX_TOKEN_ID, PROXMOX_TOKEN_SECRET");
        console.warn("   Or node-specific: <NODENAME>_TOKEN_SECRET (e.g., PROXBIG_TOKEN_SECRET)");
        console.warn("   Current values:");
        console.warn(`     PROXMOX_URL: ${proxmoxUrl ? `✓ (${proxmoxUrl})` : "✗"}`);
        console.warn(`     PROXMOX_TOKEN_ID: ${tokenId ? `✓ (${tokenId.substring(0, 20)}...)` : "✗"}`);
        console.warn(`     PROXMOX_TOKEN_SECRET: ${tokenSecret ? "✓ (hidden)" : "✗"}`);
        if (proxmoxUrl) {
          try {
            const urlObj = new URL(proxmoxUrl);
            const nodeName = urlObj.hostname.split('.')[0].toUpperCase();
            const nodeSecret = process.env[`${nodeName}_TOKEN_SECRET`];
            console.warn(`     ${nodeName}_TOKEN_SECRET: ${nodeSecret ? "✓ (hidden)" : "✗"}`);
          } catch {}
        }
      } else {
        // Normalize URL (remove /api2/json if present, we'll add it in ProxmoxClient)
        let normalizedUrl = proxmoxUrl.replace(/\/api2\/json\/?$/, "");

        console.log("🔍 Proxmox configuration:");
        console.log(`   URL: ${normalizedUrl}`);
        console.log(`   Token ID: ${tokenId}`);
        console.log(`   Token Secret: ${tokenSecret ? "✓ (hidden)" : "✗"}`);

        const proxmoxClient = new ProxmoxClient({
          url: normalizedUrl,
          tokenId,
          tokenSecret,
          verifySsl: process.env.PROXMOX_VERIFY_SSL !== "false",
        });

        // Test authentication before registering
        try {
          console.log("🔐 Testing Proxmox authentication...");
          const testResult = await proxmoxClient.get("/version");
          console.log("✅ Proxmox authentication successful");
          console.log(`   Version: ${testResult.data?.data?.version || "unknown"}`);
          discoveryRegistry.register(new ProxmoxDiscoveryService(proxmoxClient, normalizedUrl));
          console.log("✅ Registered Proxmox discovery service");
        } catch (authError: any) {
          console.error("❌ Proxmox authentication failed");
          console.error(`   Status: ${authError.response?.status || "unknown"}`);
          console.error(`   URL tested: ${normalizedUrl}/api2/json/version`);
          console.error(`   Token ID used: ${tokenId}`);
          console.error(`   Token Secret: ${tokenSecret ? "✓ (present)" : "✗ (missing)"}`);
          
          if (authError.response?.status === 401) {
            console.error("\n   This usually means:");
            console.error("   1. Token ID or secret is incorrect");
            console.error("   2. Token has no ACLs/permissions assigned");
            console.error("   3. Wrong token secret (check for node-specific secrets)");
            console.error("\n   Fix:");
            console.error("   - Verify token secret matches the token ID");
            console.error("   - Check for node-specific secret: <NODENAME>_TOKEN_SECRET");
            console.error("   - Run: pveum aclmod / -user <user> -role PVEAuditor");
          } else if (authError.response?.status === 403) {
            console.error("\n   Token is valid but lacks required permissions");
            console.error("   Fix: Assign PVEAuditor role to the token user");
          } else {
            console.error(`   Error: ${authError.message}`);
          }
          console.warn("\n⚠️  Skipping Proxmox discovery");
        }
      }
    } catch (error: any) {
      console.error("❌ Could not register Proxmox discovery:", error.message);
      console.error("   Stack:", error.stack);
    }
  }

  if (serviceFilter === "opnsense" || serviceFilter === "all") {
    try {
      const opnsenseUrl = process.env.OPNSENSE_URL;
      const apiKey = process.env.OPNSENSE_API_KEY;
      const apiSecret = process.env.OPNSENSE_API_SECRET;

      if (!opnsenseUrl || !apiKey || !apiSecret) {
        console.warn("⚠️  OPNsense discovery skipped: Missing required environment variables");
        console.warn("   Required: OPNSENSE_URL, OPNSENSE_API_KEY, OPNSENSE_API_SECRET");
        console.warn("   Current values:");
        console.warn(`     OPNSENSE_URL: ${opnsenseUrl ? "✓" : "✗"}`);
        console.warn(`     OPNSENSE_API_KEY: ${apiKey ? "✓" : "✗"}`);
        console.warn(`     OPNSENSE_API_SECRET: ${apiSecret ? "✓" : "✗"}`);
      } else {
        const opnsenseService = new OpnsenseDiscoveryService(
          opnsenseUrl,
          apiKey,
          apiSecret,
          process.env.OPNSENSE_VERIFY_SSL !== "false"
        );
        discoveryRegistry.register(opnsenseService);
        console.log("✅ Registered OPNsense discovery service");
      }
    } catch (error: any) {
      console.error("❌ Could not register OPNsense discovery:", error.message);
    }
  }

  // Discover all endpoints
  console.log("\n🔎 Discovering endpoints...\n");
  const results = await discoveryRegistry.discoverAll();

  if (results.length === 0) {
    console.error("❌ No discovery results. Check environment variables and API connectivity.");
    process.exit(1);
  }

  // Generate gap analysis for each service
  const gapAnalyses: GapAnalysis[] = [];
  
  for (const result of results) {
    console.log(`\n📊 ${result.service.toUpperCase()}`);
    console.log(`   Discovered ${result.endpoints.length} endpoints`);
    
    const enabledActions = getEnabledActions(result.service);
    const gapAnalysis = analyzeGaps(result, enabledActions);
    gapAnalyses.push(gapAnalysis);

    console.log(`   Enabled actions: ${enabledActions.length}`);
    console.log(`   Missing endpoints: ${gapAnalysis.missingEndpoints.length}`);
    console.log(`   Enabled but not discovered: ${gapAnalysis.enabledButNotDiscovered.length}`);
  }

  // Save results
  const outputDir = join(process.cwd(), "docs", "technical", "api-discovery-results");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  
  // Save discovery results
  const discoveryFile = join(outputDir, `discovery-${timestamp}.json`);
  writeFileSync(discoveryFile, JSON.stringify(results, null, 2));
  console.log(`\n💾 Saved discovery results to: ${discoveryFile}`);

  // Save gap analysis
  const gapFile = join(outputDir, `gap-analysis-${timestamp}.json`);
  writeFileSync(gapFile, JSON.stringify(gapAnalyses, null, 2));
  console.log(`💾 Saved gap analysis to: ${gapFile}`);

  // Print summary
  console.log("\n📋 Summary:");
  gapAnalyses.forEach(analysis => {
    console.log(`\n${analysis.service}:`);
    if (analysis.missingEndpoints.length > 0) {
      console.log(`  ⚠️  ${analysis.missingEndpoints.length} discovered endpoints not enabled:`);
      analysis.missingEndpoints.slice(0, 5).forEach(e => {
        console.log(`     - ${e.method} ${e.path} (${e.category})`);
      });
      if (analysis.missingEndpoints.length > 5) {
        console.log(`     ... and ${analysis.missingEndpoints.length - 5} more`);
      }
    }
    if (analysis.enabledButNotDiscovered.length > 0) {
      console.log(`  ⚠️  ${analysis.enabledButNotDiscovered.length} enabled actions not discovered:`);
      analysis.enabledButNotDiscovered.slice(0, 5).forEach(a => {
        console.log(`     - ${a.action}`);
      });
    }
    if (analysis.missingEndpoints.length === 0 && analysis.enabledButNotDiscovered.length === 0) {
      console.log(`  ✅ All discovered endpoints are enabled`);
    }
  });

  console.log("\n✅ Discovery complete!");
}

main().catch(console.error);

