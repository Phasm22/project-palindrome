import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MCPClient } from "../src/utils/mcp-client";

describe("MCPClient", () => {
  let client: MCPClient;

  beforeEach(() => {
    // Create a mock MCP client (won't actually connect in tests)
    client = new MCPClient("echo", ["test"], {});
  });

  afterEach(() => {
    if (client) {
      client.close();
    }
  });

  test("MCPClient can be instantiated", () => {
    expect(client).toBeDefined();
  });

  test("MCPClient has listTools method", () => {
    expect(typeof client.listTools).toBe("function");
  });

  test("MCPClient has callTool method", () => {
    expect(typeof client.callTool).toBe("function");
  });

  // Note: Actual MCP connection tests would require a running MCP server
  // These are integration tests that should be run manually
});

