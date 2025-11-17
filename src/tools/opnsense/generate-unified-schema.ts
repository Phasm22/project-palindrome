#!/usr/bin/env bun

/**
 * Generate unified JSON schema for OPNsense tools (read-only + safe write)
 * This script generates tool_definition_opnsense_unified.json
 * 
 * TL-1C.3: Unified Tool Definition Generation
 */

import { OpnsenseReadOnlyTool } from "./readonly/opnsense-readonly-tool";
import { OpnsenseSafeWriteTool } from "./writes/opnsense-safewrite-tool";
import { writeFileSync } from "fs";
import { join } from "path";

const readonlyTool = new OpnsenseReadOnlyTool();
const writeTool = new OpnsenseSafeWriteTool();

const readonlySchema = readonlyTool.getSchema();
const writeSchema = writeTool.getSchema();

// Merge parameters from both tools
// We need to combine the action enums and all optional parameters
const readonlyActions = [
  // Firewall
  "firewall_rules_list",
  "firewall_aliases_list",
  "firewall_aliases_get",
  "firewall_categories_list",
  "firewall_states_list",
  // Interfaces
  "interfaces_list",
  "interface_status",
  "interfaces_vlans_list",
  "interfaces_vips_list",
  // System
  "system_status",
  "system_health",
  "system_info",
  "system_backups_list",
  // Diagnostics
  "diagnostics_arp_table",
  "diagnostics_routing_table",
  "diagnostics_interface_statistics",
  "diagnostics_system_logs",
  // DHCP
  "dhcp_leases_list",
  "dhcp_status",
  "dhcp_static_mappings_list",
];

const writeActions = [
  "create_disabled_alias",
  "enable_rule_with_confirmation",
  "update_description_field",
  "toggle_rule_enabled",
  "update_alias_description",
];

const allActions = [...readonlyActions, ...writeActions];

// Build unified parameters schema
const unifiedParameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: allActions,
      description: "The OPNsense operation to perform (read-only or safe write)",
    },
    // Read-only optional parameters
    alias_name: {
      type: "string",
      description: "Alias name (for firewall_aliases_get or create_disabled_alias)",
    },
    interface_name: {
      type: "string",
      description: "Interface name (for interface_status)",
    },
    limit: {
      type: "number",
      description: "Limit number of results (for list operations)",
    },
    // Write parameters
    dryRun: {
      type: "boolean",
      default: false,
      description: "If true, return diff preview without executing (for write operations)",
    },
    alias_type: {
      type: "string",
      enum: ["host", "network", "port"],
      description: "Alias type (required for create_disabled_alias)",
    },
    alias_content: {
      type: "string",
      description: "Alias content (required for create_disabled_alias)",
    },
    alias_description: {
      type: "string",
      description: "Alias description",
    },
    rule_uuid: {
      type: "string",
      description: "Rule UUID (required for enable_rule_with_confirmation)",
    },
    target_type: {
      type: "string",
      enum: ["rule", "alias"],
      description: "Target type (required for update_description_field)",
    },
    target_uuid: {
      type: "string",
      description: "Target UUID (required for update_description_field)",
    },
    description: {
      type: "string",
      description: "New description (required for update_description_field)",
    },
    enabled: {
      type: "boolean",
      description: "Enable/disable state (required for toggle_rule_enabled)",
    },
  },
  required: ["action"],
  additionalProperties: false,
};

// Generate unified JSON schema
const jsonSchema = {
  name: "opnsense_unified",
  description: "Unified OPNsense tool providing comprehensive read-only access and controlled safe write operations. All write operations require human confirmation and support dry-run mode.",
  parameters: unifiedParameters,
  examples: [
    ...(readonlySchema.examples || []),
    ...(writeSchema.examples || []),
  ],
  notes: [
    ...(readonlySchema.notes || []),
    ...(writeSchema.notes || []),
  ],
  metadata: {
    categories: ["opnsense", "networking", "firewall", "system", "write"],
    allowedAcls: {
      read: readonlyTool.metadata.allowedAcls || [],
      write: writeTool.metadata.allowedAcls || [],
    },
    risk: {
      read: readonlyTool.metadata.risk || "low",
      write: writeTool.metadata.risk || "medium",
    },
    requiresConfirmation: {
      read: false,
      write: writeTool.metadata.requiresConfirmation || true,
    },
  },
  actions: {
    read: readonlyActions,
    write: writeActions,
    all: allActions,
  },
  actionCount: {
    read: readonlyActions.length,
    write: writeActions.length,
    total: allActions.length,
  },
  version: "1.0.0",
  generatedAt: new Date().toISOString(),
};

// Write to file
const outputPath = join(process.cwd(), "tool_definition_opnsense_unified.json");
writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2));

console.log(`✅ Generated ${outputPath}`);
console.log(`   Total Actions: ${jsonSchema.actionCount.total}`);
console.log(`   Read Actions: ${jsonSchema.actionCount.read}`);
console.log(`   Write Actions: ${jsonSchema.actionCount.write}`);
console.log(`   Categories: ${jsonSchema.metadata.categories.join(", ")}`);
console.log(`   Read ACLs: ${jsonSchema.metadata.allowedAcls.read.join(", ")}`);
console.log(`   Write ACLs: ${jsonSchema.metadata.allowedAcls.write.join(", ")}`);
console.log(`   Write Requires Confirmation: ${jsonSchema.metadata.requiresConfirmation.write}`);

