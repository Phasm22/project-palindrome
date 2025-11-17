import { BaseTool } from "../tools/BaseTool";
import { GlancesTool } from "../tools/GlancesTool";
import { OpnsenseTool } from "../tools/OpnsenseTool";
import { SSHTool } from "../tools/SSHTool";
import { MCPOpnsenseTool } from "../tools/MCPOpnsenseTool";

export function loadTools(): BaseTool[] {
  const tools: BaseTool[] = [
    new GlancesTool(),
    new OpnsenseTool(),
    new SSHTool(),
  ];

  // Conditionally load MCP OPNsense tool if MCP is configured
  // Check if MCP environment variables are set
  if (process.env.OPNSENSE_URL && process.env.OPNSENSE_API_KEY && process.env.OPNSENSE_API_SECRET) {
    try {
      tools.push(new MCPOpnsenseTool());
    } catch (error) {
      // MCP tool failed to initialize, skip it
      console.warn("MCP OPNsense tool not available:", error);
    }
  }

  return tools;
}

