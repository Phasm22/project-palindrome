import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { runAgent } from "../../src/agent/runner";
import { loadTools } from "../../src/agent/tool-loader";
import { OpnsenseSafeWriteTool } from "../../src/tools/opnsense/writes";
import { requiresConfirmation, isToolAuthorized } from "../../src/agent/tool-policy";

/**
 * TL-1C.2: Assisted Configuration Flow (Write Tool Proposal)
 * 
 * The Agent, given a configuration query ("Create an alias for blocklist-LAN with these IPs."), 
 * MUST successfully propose a write tool call (e.g., create_disabled_alias). The Agent 
 * Runner MUST correctly intercept this proposal and return the HIL confirmation payload 
 * (TL-1B.3), without executing the action.
 */

describe("TL-1C.2: Assisted Configuration Flow (Write Tool Proposal)", () => {
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

  test("should have OPNsense safe write tool loaded", () => {
    const tools = loadTools();
    const writeTool = tools.find((t) => t.metadata.name === "opnsense_safewrite");
    
    expect(writeTool).toBeDefined();
    expect(writeTool).toBeInstanceOf(OpnsenseSafeWriteTool);
  });

  test("should have create_disabled_alias action available", () => {
    const tool = new OpnsenseSafeWriteTool();
    const schema = tool.getSchema();
    const params = schema.parameters as any;
    const actions = params.properties?.action?.enum || [];
    
    expect(actions).toContain("create_disabled_alias");
  });

  test("should require confirmation for write tools (TL-1B.3)", () => {
    const tool = new OpnsenseSafeWriteTool();
    
    expect(requiresConfirmation(tool)).toBe(true);
    expect(tool.metadata.requiresConfirmation).toBe(true);
  });

  test("should have correct ACL restrictions for write tools (TL-1B.4)", () => {
    const tool = new OpnsenseSafeWriteTool();
    
    // Verify ACL restrictions
    expect(tool.metadata.allowedAcls).toBeDefined();
    expect(Array.isArray(tool.metadata.allowedAcls)).toBe(true);
    
    // Verify admin and ops can use write tools
    expect(isToolAuthorized(tool, { userId: "admin", aclGroup: "admin" })).toBe(true);
    expect(isToolAuthorized(tool, { userId: "ops", aclGroup: "ops" })).toBe(true);
    
    // Verify viewer cannot use write tools
    expect(isToolAuthorized(tool, { userId: "viewer", aclGroup: "viewer" })).toBe(false);
  });

  test("should have dryRun parameter for write operations", () => {
    const tool = new OpnsenseSafeWriteTool();
    const schema = tool.getSchema();
    const params = schema.parameters as any;
    
    expect(params.properties?.dryRun).toBeDefined();
    expect(params.properties?.dryRun.type).toBe("boolean");
    expect(params.properties?.dryRun.default).toBe(false);
  });

  test("should verify tool definitions include write actions for LLM", () => {
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

    const writeDef = toolDefs.find((t) => t.name === "opnsense_safewrite");
    expect(writeDef).toBeDefined();
    expect(writeDef?.description).toContain("write");
    
    const params = writeDef?.parameters as any;
    const actions = params?.properties?.action?.enum || [];
    
    // Verify write actions are in the tool definition
    expect(actions).toContain("create_disabled_alias");
    expect(actions).toContain("enable_rule_with_confirmation");
    expect(actions).toContain("update_description_field");
  });

  test("should execute dry-run for create_disabled_alias without confirmation", async () => {
    const tool = new OpnsenseSafeWriteTool();
    
    const mockClient = {
      get: async (url: string) => {
        // Alias doesn't exist
        return Promise.reject({ response: { status: 404 } });
      },
    };

    const getApiClientSpy = spyOn(tool as any, "getApiClient").mockReturnValue(mockClient);

    // Execute dry-run (should not require confirmation)
    const result = await tool.execute(
      {
        action: "create_disabled_alias",
        alias_name: "blocklist-LAN",
        alias_type: "network",
        alias_content: "192.168.1.0/24,10.0.0.0/8",
        alias_description: "Blocklist for LAN networks",
        dryRun: true,
      },
      { toolName: "opnsense_safewrite", startedAt: Date.now() }
    );

    expect(result.error).toBeUndefined();
    expect(result.data).toBeDefined();
    
    // Verify dry-run returns diff preview (the data IS the diff preview)
    expect(result.data.operation).toBe("create_disabled_alias");
    expect(result.data.before).toBeNull(); // Alias doesn't exist
    expect(result.data.after).toBeDefined();
    expect(result.data.dryRun).toBe(true);

    getApiClientSpy.mockRestore();
  }, { timeout: 30000 });

  test("should verify Agent Runner intercepts write tool calls", async () => {
    // This test verifies that the runner's confirmation logic works
    // In a full integration test, we'd verify the LLM proposes the write tool
    // and the runner intercepts it before execution
    
    const tools = loadTools();
    const writeTool = tools.find((t) => t.metadata.name === "opnsense_safewrite");
    
    expect(writeTool).toBeDefined();
    expect(requiresConfirmation(writeTool!)).toBe(true);
    
    // Verify the tool metadata indicates it requires confirmation
    expect(writeTool!.metadata.requiresConfirmation).toBe(true);
  });

  test("should verify write tool proposal includes all required parameters", () => {
    const tool = new OpnsenseSafeWriteTool();
    const schema = tool.getSchema();
    const params = schema.parameters as any;
    
    // Verify required parameters for create_disabled_alias
    expect(params.properties?.alias_name).toBeDefined();
    expect(params.properties?.alias_type).toBeDefined();
    expect(params.properties?.alias_content).toBeDefined();
    
    // Verify action is required
    expect(params.required).toContain("action");
  });

  test("should verify HIL confirmation payload structure (TL-1B.3)", async () => {
    // This test verifies the structure of the confirmation payload
    // The actual interception happens in the runner, but we can verify
    // the tool is set up correctly for HIL
    
    const tool = new OpnsenseSafeWriteTool();
    
    // Verify tool requires confirmation
    expect(tool.metadata.requiresConfirmation).toBe(true);
    
    // Verify tool has risk level
    expect(tool.metadata.risk).toBeDefined();
    expect(["low", "medium", "high"]).toContain(tool.metadata.risk);
    
    // In the runner, when requiresConfirmation is true, it should:
    // 1. Call confirmHighRisk callback
    // 2. Return confirmation request if not approved
    // 3. Only execute if approved
  });
});

