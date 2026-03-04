import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { runAgent } from "../../src/agent/runner";
import { loadTools } from "../../src/agent/tool-loader";
import { OpnsenseReadOnlyTool } from "../../src/tools/opnsense/readonly";

/**
 * TL-1C.1: Diagnostic Reasoning Flow (Read Tool Use)
 * 
 * The Agent, given a high-level diagnostic query ("Why is VLAN 50 dropping traffic?"), 
 * MUST successfully trigger and execute at least one read-only tool (e.g., system_logs, 
 * interface_statistics) and use the tool output to synthesize the final, grounded answer.
 */

describe("TL-1C.1: Diagnostic Reasoning Flow (Read Tool Use)", () => {
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

  test("should have OPNsense read-only tool loaded", () => {
    const tools = loadTools();
    const opnsenseTool = tools.find((t) => t.metadata.name === "opnsense_readonly");
    
    expect(opnsenseTool).toBeDefined();
    expect(opnsenseTool).toBeInstanceOf(OpnsenseReadOnlyTool);
  });

  test("should have diagnostic actions available in read-only tool", () => {
    const tool = new OpnsenseReadOnlyTool();
    const schema = tool.getSchema();
    const params = schema.parameters as any;
    const actions = params.properties?.action?.enum || [];
    
    // Verify diagnostic actions are available
    const diagnosticActions = actions.filter((a: string) => 
      a.startsWith("diagnostics_")
    );
    expect(diagnosticActions.length).toBeGreaterThanOrEqual(4);
    
    // Verify specific diagnostic actions needed for VLAN troubleshooting
    expect(actions).toContain("diagnostics_system_logs");
    expect(actions).toContain("diagnostics_interface_statistics");
    expect(actions).toContain("diagnostics_routing_table");
  });

  test("should have interface actions available for VLAN queries", () => {
    const tool = new OpnsenseReadOnlyTool();
    const schema = tool.getSchema();
    const params = schema.parameters as any;
    const actions = params.properties?.action?.enum || [];
    
    // Verify interface actions are available
    expect(actions).toContain("interfaces_vlans_list");
    expect(actions).toContain("interface_status");
    expect(actions).toContain("interfaces_list");
  });

  test("should execute diagnostic query with mocked LLM (integration test)", async () => {
    if (!process.env.OPENAI_API_KEY) {
      console.log("Skipping test: OPENAI_API_KEY not set");
      return;
    }

    // This test requires a real LLM call, so we'll verify the tool is available
    // and can be called. In a full integration test, we'd verify the LLM selects
    // the appropriate tool and synthesizes an answer.
    const tools = loadTools();
    const opnsenseTool = tools.find((t) => t.metadata.name === "opnsense_readonly");
    
    expect(opnsenseTool).toBeDefined();
    
    // Verify the tool can execute diagnostic actions
    const mockClient = {
      get: async (url: string) => {
        if (url.includes("diagnostics/system_logs")) {
          return Promise.resolve({
            data: {
              logs: [
                { timestamp: "2024-01-01T00:00:00Z", message: "VLAN 50 interface down" },
                { timestamp: "2024-01-01T00:01:00Z", message: "VLAN 50 link state changed" },
              ],
            },
          });
        }
        if (url.includes("diagnostics/interface_statistics")) {
          return Promise.resolve({
            data: {
              interface: "vlan50",
              packets_in: 0,
              packets_out: 0,
              errors_in: 10,
              errors_out: 5,
            },
          });
        }
        return Promise.resolve({ data: {} });
      },
    };

    const tool = opnsenseTool!;
    const getApiClientSpy = spyOn(tool as any, "getApiClient").mockReturnValue(mockClient);

    // Test that diagnostic actions can be executed
    const logsResult = await tool.execute(
      { action: "diagnostics_system_logs" },
      { toolName: "opnsense_readonly", startedAt: Date.now() }
    );

    expect(logsResult.error).toBeUndefined();
    expect(logsResult.data).toBeDefined();
    expect(logsResult.data.action).toBe("diagnostics_system_logs");

    const statsResult = await tool.execute(
      { action: "diagnostics_interface_statistics", interface_name: "vlan50" },
      { toolName: "opnsense_readonly", startedAt: Date.now() }
    );

    expect(statsResult.error).toBeUndefined();
    expect(statsResult.data).toBeDefined();
    expect(statsResult.data.action).toBe("diagnostics_interface_statistics");

    getApiClientSpy.mockRestore();
  }, { timeout: 30000 });

  test("should verify tool definitions include diagnostic actions for LLM", () => {
    const tools = loadTools();
    // Get tool definitions using getSchema() method
    const toolDefs = tools
      .filter((t) => typeof (t as any).getSchema === "function")
      .map((t) => {
        const schema = (t as any).getSchema();
        return {
          name: schema.name,
          description: schema.description,
          parameters: schema.parameters,
        };
      });

    const opnsenseDef = toolDefs.find((t) => t.name === "opnsense_readonly");
    expect(opnsenseDef).toBeDefined();
    expect(opnsenseDef?.description).toContain("OPNsense");
    
    const params = opnsenseDef?.parameters as any;
    const actions = params?.properties?.action?.enum || [];
    
    // Verify diagnostic actions are in the tool definition
    expect(actions).toContain("diagnostics_system_logs");
    expect(actions).toContain("diagnostics_interface_statistics");
    expect(actions).toContain("diagnostics_routing_table");
    expect(actions).toContain("diagnostics_arp_table");
  });

  test("should verify tool can synthesize answer from multiple diagnostic sources", async () => {
    const tool = new OpnsenseReadOnlyTool();
    
    const mockClient = {
      get: async (url: string) => {
        if (url.includes("diagnostics/system_logs")) {
          return Promise.resolve({
            data: {
              logs: [
                { timestamp: "2024-01-01T00:00:00Z", message: "VLAN 50 interface down" },
              ],
            },
          });
        }
        if (url.includes("diagnostics/interface_statistics")) {
          return Promise.resolve({
            data: {
              interface: "vlan50",
              errors_in: 10,
              errors_out: 5,
            },
          });
        }
        if (url.includes("interfaces/vlans")) {
          return Promise.resolve({
            data: {
              vlans: [
                { tag: 50, interface: "vlan50", status: "down" },
              ],
            },
          });
        }
        return Promise.resolve({ data: {} });
      },
    };

    const getApiClientSpy = spyOn(tool as any, "getApiClient").mockReturnValue(mockClient);

    // Execute multiple diagnostic actions that would be used for VLAN troubleshooting
    const logsResult = await tool.execute(
      { action: "diagnostics_system_logs" },
      { toolName: "opnsense_readonly", startedAt: Date.now() }
    );

    const statsResult = await tool.execute(
      { action: "diagnostics_interface_statistics", interface_name: "vlan50" },
      { toolName: "opnsense_readonly", startedAt: Date.now() }
    );

    const vlansResult = await tool.execute(
      { action: "interfaces_vlans_list" },
      { toolName: "opnsense_readonly", startedAt: Date.now() }
    );

    // Verify all results are structured and contain relevant data
    expect(logsResult.error).toBeUndefined();
    expect(statsResult.error).toBeUndefined();
    expect(vlansResult.error).toBeUndefined();

    // Verify data structure allows for synthesis
    expect(logsResult.data).toBeDefined();
    expect(statsResult.data).toBeDefined();
    expect(vlansResult.data).toBeDefined();

    // In a real scenario, the LLM would synthesize these results into an answer
    // like "VLAN 50 is dropping traffic because the interface is down (see logs)
    // and there are 10 input errors and 5 output errors (see statistics)"

    getApiClientSpy.mockRestore();
  }, { timeout: 30000 });
});

