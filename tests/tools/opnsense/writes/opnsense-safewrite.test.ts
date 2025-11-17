import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { OpnsenseSafeWriteTool } from "../../../../src/tools/opnsense/writes";
import { OpnsenseSafeWriteParams } from "../../../../src/tools/opnsense/writes";
import { isToolAuthorized, requiresConfirmation, getToolRisk } from "../../../../src/agent/tool-policy";
import type { ToolSession } from "../../../../src/agent/tool-policy";

describe("TL-1B: OPNsense Safe Write Tool", () => {
  let tool: OpnsenseSafeWriteTool;
  const originalEnv = process.env;

  beforeEach(() => {
    tool = new OpnsenseSafeWriteTool();
    process.env = {
      ...originalEnv,
      OPNSENSE_URL: "https://opnsense.example.com",
      OPNSENSE_API_KEY: "test-key",
      OPNSENSE_API_SECRET: "test-secret",
      OPNSENSE_VERIFY_SSL: "true",
    };
  });

  describe("TL-1B.1: Restricted Write Action Implementation", () => {
    test("should have 3-5 designated low-risk write actions", () => {
      const schema = tool.getSchema();
      const params = schema.parameters as any;
      const actions = params.properties?.action?.enum || [];
      
      expect(actions.length).toBeGreaterThanOrEqual(3);
      expect(actions.length).toBeLessThanOrEqual(5);
    });

    test("should include create_disabled_alias action", () => {
      const schema = tool.getSchema();
      const params = schema.parameters as any;
      const actions = params.properties?.action?.enum || [];
      
      expect(actions).toContain("create_disabled_alias");
    });

    test("should include enable_rule_with_confirmation action", () => {
      const schema = tool.getSchema();
      const params = schema.parameters as any;
      const actions = params.properties?.action?.enum || [];
      
      expect(actions).toContain("enable_rule_with_confirmation");
    });

    test("should include update_description_field action", () => {
      const schema = tool.getSchema();
      const params = schema.parameters as any;
      const actions = params.properties?.action?.enum || [];
      
      expect(actions).toContain("update_description_field");
    });

    test("should have no unauthorized write actions", () => {
      const schema = tool.getSchema();
      const params = schema.parameters as any;
      const actions = params.properties?.action?.enum || [];
      
      // Only allow the designated low-risk actions
      const allowedActions = [
        "create_disabled_alias",
        "enable_rule_with_confirmation",
        "update_description_field",
        "toggle_rule_enabled",
        "update_alias_description",
      ];
      
      actions.forEach((action: string) => {
        expect(allowedActions).toContain(action);
      });
    });
  });

  describe("TL-1B.2: Mandatory Dry-Run and Diff Preview", () => {
    test("should support dryRun parameter for all actions", () => {
      const schema = tool.getSchema();
      const params = schema.parameters as any;
      
      expect(params.properties?.dryRun).toBeDefined();
      expect(params.properties?.dryRun.type).toBe("boolean");
    });

    test("should return diff preview when dryRun is true for create_disabled_alias", async () => {
      const mockClient = {
        get: async () => Promise.reject({ response: { status: 404 } }), // Alias doesn't exist
      };

      const getApiClientSpy = spyOn(tool as any, "getApiClient").mockReturnValue(mockClient);

      const result = await tool.execute(
        {
          action: "create_disabled_alias",
          alias_name: "test-alias",
          alias_type: "host",
          alias_content: "192.168.1.100",
          alias_description: "Test alias",
          dryRun: true,
        },
        { toolName: "opnsense_safewrite", startedAt: Date.now() }
      );

      expect(result.error).toBeUndefined();
      expect(result.data).toBeDefined();
      expect(result.data.dryRun).toBe(true);
      expect(result.data.operation).toBe("create_disabled_alias");
      expect(result.data.before).toBeDefined();
      expect(result.data.after).toBeDefined();
      expect(result.data.changes).toBeDefined();
      expect(Array.isArray(result.data.changes)).toBe(true);
      
      getApiClientSpy.mockRestore();
    });

    test("should return diff preview when dryRun is true for enable_rule_with_confirmation", async () => {
      const mockRule = {
        uuid: "test-uuid",
        enabled: false,
        description: "Test rule",
      };

      const mockClient = {
        get: async () => Promise.resolve({
          data: { rule: mockRule }
        }),
      };

      const getApiClientSpy = spyOn(tool as any, "getApiClient").mockReturnValue(mockClient);

      const result = await tool.execute(
        {
          action: "enable_rule_with_confirmation",
          rule_uuid: "test-uuid",
          dryRun: true,
        },
        { toolName: "opnsense_safewrite", startedAt: Date.now() }
      );

      expect(result.error).toBeUndefined();
      expect(result.data).toBeDefined();
      expect(result.data.dryRun).toBe(true);
      expect(result.data.operation).toBe("enable_rule_with_confirmation");
      expect(result.data.before).toBeDefined();
      expect(result.data.after).toBeDefined();
      expect(result.data.changes).toBeDefined();
      expect(Array.isArray(result.data.changes)).toBe(true);
      
      // Verify the change shows enabled going from false to true
      const enabledChange = result.data.changes.find((c: any) => c.field === "enabled");
      expect(enabledChange).toBeDefined();
      expect(enabledChange.oldValue).toBe(false);
      expect(enabledChange.newValue).toBe(true);
      
      getApiClientSpy.mockRestore();
    });

    test("should not execute API call when dryRun is true", async () => {
      const mockClient = {
        get: async () => Promise.resolve({
          data: { rule: { uuid: "test-uuid", enabled: false } }
        }),
        post: async () => Promise.reject(new Error("Should not be called")),
      };

      const getApiClientSpy = spyOn(tool as any, "getApiClient").mockReturnValue(mockClient);
      const postSpy = spyOn(mockClient, "post");

      const result = await tool.execute(
        {
          action: "enable_rule_with_confirmation",
          rule_uuid: "test-uuid",
          dryRun: true,
        },
        { toolName: "opnsense_safewrite", startedAt: Date.now() }
      );

      expect(result.error).toBeUndefined();
      expect(postSpy).not.toHaveBeenCalled();
      
      getApiClientSpy.mockRestore();
    });
  });

  describe("TL-1B.3: Confirmation Middleware Trigger", () => {
    test("should have requiresConfirmation flag set to true", () => {
      expect(requiresConfirmation(tool)).toBe(true);
      expect(tool.metadata.requiresConfirmation).toBe(true);
    });

    test("should have requiresConfirmation in tool schema metadata", () => {
      const schema = tool.getSchema();
      // The schema should indicate this tool requires confirmation
      // This is handled by the tool metadata, not the schema itself
      expect(tool.metadata.requiresConfirmation).toBe(true);
    });

    test("should have risk level set appropriately", () => {
      const risk = getToolRisk(tool);
      expect(["medium", "high"]).toContain(risk);
      expect(tool.metadata.risk).toBeDefined();
    });
  });

  describe("TL-1B.4: Write ACL Enforcement", () => {
    test("should only allow admin and ops ACL groups", () => {
      expect(tool.metadata.allowedAcls).toBeDefined();
      expect(tool.metadata.allowedAcls).toContain("admin");
      expect(tool.metadata.allowedAcls).toContain("ops");
    });

    test("should block viewer ACL group", () => {
      const viewerSession: ToolSession = {
        userId: "viewer-user",
        aclGroup: "viewer",
      };

      expect(isToolAuthorized(tool, viewerSession)).toBe(false);
    });

    test("should allow admin ACL group", () => {
      const adminSession: ToolSession = {
        userId: "admin-user",
        aclGroup: "admin",
      };

      expect(isToolAuthorized(tool, adminSession)).toBe(true);
    });

    test("should allow ops ACL group", () => {
      const opsSession: ToolSession = {
        userId: "ops-user",
        aclGroup: "ops",
      };

      expect(isToolAuthorized(tool, opsSession)).toBe(true);
    });

    test("should block standard-user ACL group", () => {
      const standardSession: ToolSession = {
        userId: "standard-user",
        aclGroup: "standard-user",
      };

      expect(isToolAuthorized(tool, standardSession)).toBe(false);
    });
  });

  describe("TL-1B.5: Pre-Write State Provenance Capture", () => {
    test("should capture pre-write state before executing write", async () => {
      const mockRule = {
        uuid: "test-uuid",
        enabled: false,
        description: "Original description",
      };

      const mockClient = {
        get: async () => Promise.resolve({
          data: { rule: mockRule }
        }),
        post: async () => Promise.resolve({
          data: { result: "success" }
        }),
      };

      const getApiClientSpy = spyOn(tool as any, "getApiClient").mockReturnValue(mockClient);

      const result = await tool.execute(
        {
          action: "enable_rule_with_confirmation",
          rule_uuid: "test-uuid",
          dryRun: false,
        },
        { toolName: "opnsense_safewrite", startedAt: Date.now() }
      );

      expect(result.error).toBeUndefined();
      expect(result.data).toBeDefined();
      expect(result.data.provenance).toBeDefined();
      expect(result.data.provenance.snapshotId).toBeDefined();
      expect(result.data.provenance.versionHash).toBeDefined();
      expect(result.data.provenance.timestamp).toBeDefined();
      expect(result.data.provenance.targetType).toBe("rule");
      expect(result.data.provenance.targetId).toBe("test-uuid");
      expect(result.data.provenance.state).toBeDefined();
      expect(result.data.provenance.state.enabled).toBe(false); // Pre-write state
      
      getApiClientSpy.mockRestore();
    });

    test("should generate unique hash for each snapshot", async () => {
      const mockRule = {
        uuid: "test-uuid",
        enabled: false,
      };

      const mockClient = {
        get: async () => Promise.resolve({
          data: { rule: mockRule }
        }),
        post: async () => Promise.resolve({
          data: { result: "success" }
        }),
      };

      const getApiClientSpy = spyOn(tool as any, "getApiClient").mockReturnValue(mockClient);

      const result1 = await tool.execute(
        {
          action: "enable_rule_with_confirmation",
          rule_uuid: "test-uuid",
          dryRun: false,
        },
        { toolName: "opnsense_safewrite", startedAt: Date.now() }
      );

      // Small delay to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10));

      const result2 = await tool.execute(
        {
          action: "enable_rule_with_confirmation",
          rule_uuid: "test-uuid",
          dryRun: false,
        },
        { toolName: "opnsense_safewrite", startedAt: Date.now() }
      );

      expect(result1.data.provenance.snapshotId).not.toBe(result2.data.provenance.snapshotId);
      expect(result1.data.provenance.versionHash).toBe(result2.data.provenance.versionHash); // Same state = same hash
      
      getApiClientSpy.mockRestore();
    });

    test("should capture state before API call is made", async () => {
      const originalRule = {
        uuid: "test-uuid",
        enabled: false,
        description: "Original",
      };

      let capturedState: any = null;
      const mockClient = {
        get: async () => Promise.resolve({
          data: { rule: originalRule }
        }),
        post: async (url: string, data: any) => {
          // Verify the state was captured before this call
          expect(capturedState).toBeDefined();
          expect(capturedState.enabled).toBe(false);
          return Promise.resolve({
            data: { result: "success" }
          });
        },
      };

      const getApiClientSpy = spyOn(tool as any, "getApiClient").mockReturnValue(mockClient);
      
      // Spy on capturePreWriteState to track when it's called
      const captureSpy = spyOn(tool as any, "capturePreWriteState").mockImplementation(
        async (targetType: string, targetId: string, getCurrentState: () => Promise<any>) => {
          const state = await getCurrentState();
          capturedState = state;
          return {
            snapshotId: "test-snapshot",
            versionHash: "test-hash",
            timestamp: new Date().toISOString(),
            targetType,
            targetId,
            state,
          };
        }
      );

      await tool.execute(
        {
          action: "enable_rule_with_confirmation",
          rule_uuid: "test-uuid",
          dryRun: false,
        },
        { toolName: "opnsense_safewrite", startedAt: Date.now() }
      );

      expect(captureSpy).toHaveBeenCalled();
      expect(capturedState).toBeDefined();
      
      getApiClientSpy.mockRestore();
      captureSpy.mockRestore();
    });
  });

  describe("TL-1B.6: End-to-End Success Path Validation", () => {
    test("should successfully execute full confirmed flow for create_disabled_alias", async () => {
      const mockClient = {
        get: async () => Promise.reject({ response: { status: 404 } }), // Alias doesn't exist
        post: async () => Promise.resolve({
          data: { result: "success", uuid: "new-alias-uuid" }
        }),
      };

      const getApiClientSpy = spyOn(tool as any, "getApiClient").mockReturnValue(mockClient);

      // Step 1: Dry-run
      const dryRunResult = await tool.execute(
        {
          action: "create_disabled_alias",
          alias_name: "test-alias",
          alias_type: "host",
          alias_content: "192.168.1.100",
          alias_description: "Test alias",
          dryRun: true,
        },
        { toolName: "opnsense_safewrite", startedAt: Date.now() }
      );

      expect(dryRunResult.error).toBeUndefined();
      expect(dryRunResult.data.dryRun).toBe(true);

      // Step 2: Actual write (simulating confirmed flow)
      const writeResult = await tool.execute(
        {
          action: "create_disabled_alias",
          alias_name: "test-alias",
          alias_type: "host",
          alias_content: "192.168.1.100",
          alias_description: "Test alias",
          dryRun: false,
        },
        { toolName: "opnsense_safewrite", startedAt: Date.now() }
      );

      expect(writeResult.error).toBeUndefined();
      expect(writeResult.data.action).toBe("create_disabled_alias");
      expect(writeResult.data.result).toBeDefined();
      expect(writeResult.data.timestamp).toBeDefined();
      
      getApiClientSpy.mockRestore();
    });

    test("should successfully execute full confirmed flow for enable_rule_with_confirmation", async () => {
      const mockRule = {
        uuid: "test-uuid",
        enabled: false,
        description: "Test rule",
      };

      const mockClient = {
        get: async () => Promise.resolve({
          data: { rule: mockRule }
        }),
        post: async () => Promise.resolve({
          data: { result: "success" }
        }),
      };

      const getApiClientSpy = spyOn(tool as any, "getApiClient").mockReturnValue(mockClient);

      // Step 1: Dry-run
      const dryRunResult = await tool.execute(
        {
          action: "enable_rule_with_confirmation",
          rule_uuid: "test-uuid",
          dryRun: true,
        },
        { toolName: "opnsense_safewrite", startedAt: Date.now() }
      );

      expect(dryRunResult.error).toBeUndefined();
      expect(dryRunResult.data.dryRun).toBe(true);
      expect(dryRunResult.data.changes).toBeDefined();

      // Step 2: Actual write (simulating confirmed flow)
      const writeResult = await tool.execute(
        {
          action: "enable_rule_with_confirmation",
          rule_uuid: "test-uuid",
          dryRun: false,
        },
        { toolName: "opnsense_safewrite", startedAt: Date.now() }
      );

      expect(writeResult.error).toBeUndefined();
      expect(writeResult.data.action).toBe("enable_rule_with_confirmation");
      expect(writeResult.data.provenance).toBeDefined();
      expect(writeResult.data.result).toBeDefined();
      expect(writeResult.data.timestamp).toBeDefined();
      
      getApiClientSpy.mockRestore();
    });

    test("should include provenance in final answer", async () => {
      const mockRule = {
        uuid: "test-uuid",
        enabled: false,
      };

      const mockClient = {
        get: async () => Promise.resolve({
          data: { rule: mockRule }
        }),
        post: async () => Promise.resolve({
          data: { result: "success" }
        }),
      };

      const getApiClientSpy = spyOn(tool as any, "getApiClient").mockReturnValue(mockClient);

      const result = await tool.execute(
        {
          action: "enable_rule_with_confirmation",
          rule_uuid: "test-uuid",
          dryRun: false,
        },
        { toolName: "opnsense_safewrite", startedAt: Date.now() }
      );

      expect(result.error).toBeUndefined();
      expect(result.data.provenance).toBeDefined();
      expect(result.data.provenance.snapshotId).toBeDefined();
      expect(result.data.provenance.versionHash).toBeDefined();
      expect(result.data.provenance.targetType).toBe("rule");
      expect(result.data.provenance.targetId).toBe("test-uuid");
      
      getApiClientSpy.mockRestore();
    });
  });

  describe("Error Handling", () => {
    test("should return error for missing required parameters", async () => {
      const result = await tool.execute(
        {
          action: "create_disabled_alias",
          // Missing required parameters
        },
        { toolName: "opnsense_safewrite", startedAt: Date.now() }
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("required");
    });

    test("should return error for invalid action", async () => {
      const result = await tool.execute(
        {
          action: "invalid_action",
        },
        { toolName: "opnsense_safewrite", startedAt: Date.now() }
      );

      expect(result.error).toBeDefined();
    });

    test("should handle API errors gracefully", async () => {
      const mockClient = {
        get: async () => Promise.reject({
          response: { status: 500, data: { message: "Internal server error" } }
        }),
      };

      const getApiClientSpy = spyOn(tool as any, "getApiClient").mockReturnValue(mockClient);

      const result = await tool.execute(
        {
          action: "enable_rule_with_confirmation",
          rule_uuid: "test-uuid",
          dryRun: false,
        },
        { toolName: "opnsense_safewrite", startedAt: Date.now() }
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain("OPNsense API error");
      
      getApiClientSpy.mockRestore();
    });
  });
});

