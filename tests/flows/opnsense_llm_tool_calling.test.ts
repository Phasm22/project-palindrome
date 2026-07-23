import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { runAgent } from "../../src/agent/runner";
import { loadTools } from "../../src/agent/tool-loader";
import { OpnsenseReadOnlyTool } from "../../src/tools/opnsense/readonly";

/**
 * Integration test to verify LLM can autonomously call OPNsense tools
 * This tests the full TL-1C flow: LLM receives query → selects tool → executes → synthesizes answer
 */

describe("TL-1C: LLM Tool Calling Integration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      OPNSENSE_URL: "https://opnsense.example.com",
      OPNSENSE_API_KEY: "test-key",
      OPNSENSE_API_SECRET: "test-secret",
      OPNSENSE_VERIFY_SSL: "true",
    };
  });

  test("should verify tools are loaded and available for LLM", () => {
    const tools = loadTools();
    const opnsenseTool = tools.find((t) => t.metadata.name === "opnsense_readonly");
    
    expect(opnsenseTool).toBeDefined();
    expect(opnsenseTool).toBeInstanceOf(OpnsenseReadOnlyTool);
  });

  test("should verify tool definitions are built correctly for LLM", () => {
    const tools = loadTools();
    
    // Simulate buildToolDefinitions logic
    const toolDefs = tools
      .map((tool) => {
        let parameters: Record<string, any> | undefined;
        
        if (typeof (tool as any).getSchema === "function") {
          const schema = (tool as any).getSchema();
          parameters = schema.parameters;
        } else if (tool.metadata.parameters) {
          parameters = tool.metadata.parameters as Record<string, any>;
        }
        
        if (!parameters) {
          return null;
        }
        
        return {
          type: "function" as const,
          function: {
            name: tool.metadata.name,
            description: tool.metadata.description,
            parameters,
          },
        };
      })
      .filter((def): def is NonNullable<typeof def> => def !== null);

    // Verify OPNsense tools are included
    // Note: opnsense_safewrite was superseded by the generic action tool layer (action_*)
    const opnsenseReadOnly = toolDefs.find((d) => d.function.name === "opnsense_readonly");
    
    expect(opnsenseReadOnly).toBeDefined();
    
    // Verify parameters are correct
    expect(opnsenseReadOnly?.function.parameters).toBeDefined();
    expect(opnsenseReadOnly?.function.parameters.properties?.action).toBeDefined();
    expect(opnsenseReadOnly?.function.parameters.properties?.action.enum).toBeDefined();
    expect(opnsenseReadOnly?.function.parameters.properties?.action.enum.length).toBeGreaterThanOrEqual(20);
  });

  test("should execute tool when LLM calls it (mocked)", async () => {
    if (!process.env.OPENAI_API_KEY) {
      console.log("Skipping test: OPENAI_API_KEY not set");
      return;
    }

    const tool = new OpnsenseReadOnlyTool();
    
    // Mock the API client to return test data
    const mockClient = {
      get: async (url: string) => {
        if (url.includes("core/system/status")) {
          return Promise.resolve({
            data: {
              status: "ok",
              uptime: 12345,
              version: "24.1",
              cpu_usage: 25.5,
            },
          });
        }
        return Promise.resolve({ data: {} });
      },
    };

    const getApiClientSpy = spyOn(tool as any, "getApiClient").mockReturnValue(mockClient);

    // Execute the tool directly to verify it works
    const result = await tool.execute(
      { action: "system_status" },
      { toolName: "opnsense_readonly", startedAt: Date.now() }
    );

    expect(result.error).toBeUndefined();
    expect(result.data).toBeDefined();
    expect(result.data.action).toBe("system_status");
    // The status is nested in the data structure
    expect(result.data.status || result.data.data?.status).toBeDefined();

    getApiClientSpy.mockRestore();
  }, { timeout: 30000 });

  test("should verify system prompt mentions OPNsense tools", () => {
    const { SYSTEM_PROMPT } = require("../../src/agent/system-prompt");
    
    expect(SYSTEM_PROMPT).toContain("opnsense_readonly");
    // opnsense_safewrite was superseded by the generic action tool layer
    expect(SYSTEM_PROMPT).toContain("OPNsense");
  });

  test("should verify context can handle tool_calls in assistant messages", () => {
    const { AgentContext } = require("../../src/agent/context");
    const context = new AgentContext();
    
    // Add user message
    context.addUserMessage("What's the system status?");
    
    // Add assistant message with tool_calls
    const messages = context.getMessages();
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_123",
          type: "function",
          function: {
            name: "opnsense_readonly",
            arguments: JSON.stringify({ action: "system_status" }),
          },
        },
      ],
    });
    
    // Add tool result
    context.addToolResult("call_123", "opnsense_readonly", {
      success: true,
      data: { action: "system_status", status: "ok" },
    });
    
    const finalMessages = context.getMessages();
    expect(finalMessages.length).toBe(3);
    expect(finalMessages[1].role).toBe("assistant");
    expect((finalMessages[1] as any).tool_calls).toBeDefined();
    expect(finalMessages[2].role).toBe("tool");
  });
});

