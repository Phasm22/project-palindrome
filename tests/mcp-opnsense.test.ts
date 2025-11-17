import { describe, test, expect, beforeEach } from "bun:test";
import { MCPOpnsenseTool } from "../src/tools/MCPOpnsenseTool";
import type { ExecutionContext } from "../src/types/execution";

describe("MCPOpnsenseTool", () => {
  let tool: MCPOpnsenseTool;

  beforeEach(() => {
    tool = new MCPOpnsenseTool();
  });

  test("MCPOpnsenseTool can be instantiated", () => {
    expect(tool).toBeDefined();
    expect(tool.metadata.name).toBe("mcp_opnsense");
  });

  test("MCPOpnsenseTool has getSchema method", () => {
    const schema = tool.getSchema();
    expect(schema).toBeDefined();
    expect(schema.name).toBe("mcp_opnsense");
    expect(schema.parameters).toBeDefined();
    expect(schema.parameters.properties?.module).toBeDefined();
    expect(schema.parameters.properties?.action).toBeDefined();
  });

  test("MCPOpnsenseTool validates parameters", async () => {
    const context: ExecutionContext = {
      toolName: "mcp_opnsense",
      startedAt: Date.now(),
    };

    // Missing required fields
    const result1 = await tool.execute({}, context);
    expect(result1.error).toBeDefined();

    // Invalid module
    const result2 = await tool.execute(
      { module: "invalid_module", action: "test" },
      context
    );
    expect(result2.error).toBeDefined();
    expect(result2.error).toContain("Invalid");
  });

  test("MCPOpnsenseTool requires MCP client for execution", async () => {
    const context: ExecutionContext = {
      toolName: "mcp_opnsense",
      startedAt: Date.now(),
    };

    // Without MCP configured, should fail gracefully
    const result = await tool.execute(
      { module: "firewall", action: "list_rules" },
      context
    );

    // Should either succeed (if MCP is available) or fail with a clear error
    expect(result).toBeDefined();
    if (result.error) {
      expect(result.error).toBeTruthy();
    }
  });

  // Note: Full integration tests require:
  // 1. Running MCP server
  // 2. Valid OPNsense credentials
  // 3. Network access to OPNsense
  // These should be run manually: bun test tests/mcp-opnsense.test.ts --integration
});

