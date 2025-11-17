#!/usr/bin/env bun

/**
 * Generate unified JSON schema for OPNsense safe write tools
 * This script generates tool_definition_opnsense_safewrite.json
 */

import { OpnsenseSafeWriteTool } from "./opnsense-safewrite-tool";
import { writeFileSync } from "fs";
import { join } from "path";

const tool = new OpnsenseSafeWriteTool();
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
    risk: tool.metadata.risk || "medium",
    requiresConfirmation: tool.metadata.requiresConfirmation || false,
  },
  actions: [
    "create_disabled_alias",
    "enable_rule_with_confirmation",
    "update_description_field",
    "toggle_rule_enabled",
    "update_alias_description",
  ],
  actionCount: 5,
  version: "1.0.0",
  generatedAt: new Date().toISOString(),
};

// Write to file
const outputPath = join(process.cwd(), "tool_definition_opnsense_safewrite.json");
writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2));

console.log(`✅ Generated ${outputPath}`);
console.log(`   Actions: ${jsonSchema.actionCount}`);
console.log(`   Categories: ${jsonSchema.metadata.categories.join(", ")}`);
console.log(`   Requires Confirmation: ${jsonSchema.metadata.requiresConfirmation}`);
console.log(`   Allowed ACLs: ${jsonSchema.metadata.allowedAcls.join(", ")}`);

