/**
 * Export tool schemas as JSON for external discovery
 * 
 * This allows other systems (MCP clients, API consumers, etc.) to discover
 * available tools and their capabilities without needing to load the full tool implementation.
 * 
 * Usage:
 *   bun run src/utils/export-tool-schemas.ts > tools.json
 */

import { loadTools } from "../agent/tool-loader";
import { isDescribableTool } from "../tools/BaseTool";
import type { ToolSchema } from "../tools/tool-schema";

const tools = loadTools();
const schemas: ToolSchema[] = [];

for (const tool of tools) {
  if (isDescribableTool(tool)) {
    schemas.push(tool.getSchema());
  }
}

// Output as JSON
console.log(JSON.stringify(schemas, null, 2));

