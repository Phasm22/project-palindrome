#!/usr/bin/env bun

/**
 * Generate unified JSON schema for OPNsense read-only tools
 * This script generates tool_definition_opnsense_readonly.json
 */

import { OpnsenseReadOnlyTool } from "./opnsense-readonly-tool";
import { OpnsenseReadOnlyParams } from "./opnsense-readonly-tool";
import { zodToJsonSchema } from "../../tool-schema";
import { writeFileSync } from "fs";
import { join } from "path";

const tool = new OpnsenseReadOnlyTool();
const schema = tool.getSchema();

// Generate JSON schema
const jsonSchema = {
  name: schema.name,
  description: schema.description,
  parameters: schema.parameters, // Already a JSONSchema from getSchema()
  examples: schema.examples || [],
  notes: schema.notes || [],
  metadata: {
    categories: tool.metadata.categories || [],
    allowedAcls: tool.metadata.allowedAcls || [],
    risk: tool.metadata.risk || "low",
  },
  actions: [
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
  ],
  actionCount: 20,
  version: "1.0.0",
  generatedAt: new Date().toISOString(),
};

// Write to file
const outputPath = join(process.cwd(), "tool_definition_opnsense_readonly.json");
writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2));

console.log(`✅ Generated ${outputPath}`);
console.log(`   Actions: ${jsonSchema.actionCount}`);
console.log(`   Categories: ${jsonSchema.metadata.categories.join(", ")}`);

