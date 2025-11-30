import { z } from "zod";

/**
 * OPNsense MCP modules organized by logical grouping
 * These map to the MCP server's tool names
 */
export const OPNsenseModules = z.enum([
  "core",           // Core system operations
  "firewall",       // Firewall rules, aliases, categories
  "interfaces",     // Network interfaces, VLANs, VIPs
  "routing",        // Static routes, gateways
  "dhcp",           // DHCP server configuration
  "dns",            // DNS/unbound configuration
  "vpn",            // VPN configurations (IPsec, OpenVPN, WireGuard)
  "system",         // System settings, users, backups
  "diagnostics",    // Diagnostic tools, logs, monitoring
  "firmware",       // Firmware updates, plugins
]);

export type OPNsenseModule = z.infer<typeof OPNsenseModules>;

/**
 * Common actions that appear across modules
 * These will be auto-discovered, but we define common ones here
 */
export const CommonActions = z.enum([
  "get",           // Get single item
  "list",          // List all items
  "search",        // Search items
  "status",        // Get status
  "info",          // Get information
]);

/**
 * Schema for MCP OPNsense tool parameters
 * Uses module/action pattern for logical grouping
 * 
 * Note: Some MCP tools require a "method" parameter (e.g., core_manage requires method: "systemStatus")
 * The action can be either the MCP tool name or a method name, depending on the module
 */
export const MCPOpnsenseParams = z.object({
  module: OPNsenseModules.describe("OPNsense module (e.g., firewall, system, interfaces)"),
  action: z.string().describe("Action/method to perform. For modules like 'core', this is the method name (e.g., 'systemStatus', 'backupBackups'). For other modules, this is the action name (e.g., 'list_rules', 'search_aliases'). Auto-discovered from MCP server."),
  parameters: z.any().optional().describe("Additional parameters for the action as an object. For 'core' module with 'manage' action, include 'method' parameter (e.g., {method: 'systemStatus'})."),
});

export type MCPOpnsenseParams = z.infer<typeof MCPOpnsenseParams>;

