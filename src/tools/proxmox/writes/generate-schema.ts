import { ProxmoxWriteTool } from "./proxmox-write-tool";
import { writeFileSync } from "fs";
import { join } from "path";

const tool = new ProxmoxWriteTool();
const schema = tool.getSchema?.();

if (!schema) {
  console.error("Tool does not implement getSchema()");
  process.exit(1);
}

// Generate JSON schema
const jsonSchema = {
  name: schema.name,
  description: schema.description,
  parameters: schema.parameters, // Already a JSONSchema from getSchema()
  metadata: {
    categories: tool.metadata.categories || [],
    allowedAcls: tool.metadata.allowedAcls || [],
    risk: tool.metadata.risk || "medium",
    requiresConfirmation: tool.metadata.requiresConfirmation || false,
  },
  actions: [
    "start_vm",
    "stop_vm",
    "shutdown_vm",
    "reboot_vm",
    "reset_vm",
    "create_snapshot",
    "rollback_snapshot",
    "clone_vm",
    "migrate_vm",
  ],
  actionCount: 9,
  version: "1.0.0",
  generatedAt: new Date().toISOString(),
};

// Write to file
const outputPath = join(process.cwd(), "tool_definition_proxmox_safewrite.json");
writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2));

console.log(`✅ Generated tool definition schema: ${outputPath}`);
console.log(`   Tool: ${jsonSchema.name}`);
console.log(`   Actions: ${jsonSchema.actionCount}`);
console.log(`   Allowed ACLs: ${jsonSchema.metadata.allowedAcls.join(", ")}`);
console.log(`   Requires Confirmation: ${jsonSchema.metadata.requiresConfirmation}`);
console.log(`   Risk Tier: ${jsonSchema.metadata.risk}`);

