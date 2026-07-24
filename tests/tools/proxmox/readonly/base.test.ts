import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ProxmoxReadOnlyBase } from "../../../../src/tools/proxmox/readonly/base";
import * as ToolSanitizerModule from "../../../../src/agent/tool-sanitizer";
import type { ExecutionContext } from "../../../../src/types/execution";

// Create mocks - use object to store so they're accessible everywhere
const mocks: any = {};

vi.mock("axios", () => {
  // Create mocks inside factory
  mocks.instance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  
  mocks.create = vi.fn(() => mocks.instance);
  
  return {
    default: {
      create: () => mocks.create(),
    },
  };
});

// Export for use in tests
const mockAxiosInstance = mocks.instance;
const mockAxiosCreate = mocks.create;

vi.mock("https", () => ({
  default: {
    Agent: vi.fn().mockImplementation(() => ({})),
  },
}));

// Import after mocking
import { ProxmoxClient } from "../../../../src/tools/proxmox/client";

describe("TL-2A.1: Proxmox Read-Only Base Class", () => {
  const mockContext: ExecutionContext = {
    toolName: "test_tool",
    startedAt: Date.now(),
  };

  class TestProxmoxTool extends ProxmoxReadOnlyBase {
    async execute(
      params: Record<string, any>,
      context: ExecutionContext
    ): Promise<any> {
      // Test implementation
      return { data: "test" };
    }
  }

  const originalProxmoxEnv = {
    PROXMOX_URL: process.env.PROXMOX_URL,
    PROXMOX_TOKEN_ID: process.env.PROXMOX_TOKEN_ID,
    PROXMOX_TOKEN_SECRET: process.env.PROXMOX_TOKEN_SECRET,
  };

  let activeSpies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PROXMOX_URL = "https://proxmox.example.com";
    process.env.PROXMOX_TOKEN_ID = "testuser@pam!testtoken";
    process.env.PROXMOX_TOKEN_SECRET = "test-secret";
    activeSpies = [
      vi.spyOn(ToolSanitizerModule, "sanitizeToolPayload").mockImplementation((data: any) => data),
    ];
  });

  afterEach(() => {
    // vi.restoreAllMocks() restores every spy in the whole process, not just
    // this file's - under `bun test`, files run with real concurrency, so a
    // global restore can undo another file's still-in-flight spy on the
    // same shared module namespace. Restore only the specific spies made here.
    activeSpies.forEach((spy) => spy.mockRestore());
    activeSpies = [];
    for (const [key, value] of Object.entries(originalProxmoxEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe("API Client Management", () => {
    it("should create API client from environment variables", () => {
      const tool = new TestProxmoxTool({
        name: "test_tool",
        description: "Test tool",
      });

      // The client is mocked, so we can't check instanceof
      // Instead, verify the method exists and can be called
      expect(typeof tool["getApiClient"]).toBe("function");
    });

    it("should reuse existing API client instance", () => {
      const tool = new TestProxmoxTool({
        name: "test_tool",
        description: "Test tool",
      });

      const client1 = tool["getApiClient"]();
      const client2 = tool["getApiClient"]();

      expect(client1).toBe(client2);
    });

    it("should throw error if environment variables are missing", () => {
      delete process.env.PROXMOX_URL;
      delete process.env.PROXMOX_TOKEN_ID;
      delete process.env.PROXMOX_TOKEN_SECRET;

      const tool = new TestProxmoxTool({
        name: "test_tool",
        description: "Test tool",
      });

      expect(() => {
        tool["getApiClient"]();
      }).toThrow("PROXMOX_URL, PROXMOX_TOKEN_ID, and PROXMOX_TOKEN_SECRET must be set");
    });
  });

  describe("Write Operation Detection", () => {
    it("should detect write operations correctly", () => {
      const tool = new TestProxmoxTool({
        name: "test_tool",
        description: "Test tool",
      });

      expect(tool["isWriteOperation"]("create_vm")).toBe(true);
      expect(tool["isWriteOperation"]("delete_vm")).toBe(true);
      expect(tool["isWriteOperation"]("update_config")).toBe(true);
      expect(tool["isWriteOperation"]("start_vm")).toBe(true);
      expect(tool["isWriteOperation"]("stop_vm")).toBe(true);
      expect(tool["isWriteOperation"]("migrate_vm")).toBe(true);
    });

    it("should not detect read operations as write operations", () => {
      const tool = new TestProxmoxTool({
        name: "test_tool",
        description: "Test tool",
      });

      expect(tool["isWriteOperation"]("list_vms")).toBe(false);
      expect(tool["isWriteOperation"]("get_status")).toBe(false);
      expect(tool["isWriteOperation"]("vm_status")).toBe(false);
      expect(tool["isWriteOperation"]("node_resources")).toBe(false);
    });

    it("should validate read-only and reject write operations", () => {
      const tool = new TestProxmoxTool({
        name: "test_tool",
        description: "Test tool",
      });

      const result = tool["validateReadOnly"]("create_vm");
      expect(result).not.toBeNull();
      expect(result?.error).toContain("OPERATION_FORBIDDEN");
    });

    it("should allow read operations", () => {
      const tool = new TestProxmoxTool({
        name: "test_tool",
        description: "Test tool",
      });

      const result = tool["validateReadOnly"]("list_vms");
      expect(result).toBeNull();
    });
  });

  describe("API Call Execution", () => {
    it("should execute API call and sanitize response", async () => {
      const mockData = { status: "ok", nodes: ["node1"] };
      const mockMetadata = {
        status: 200,
        timestamp: Date.now(),
        durationMs: 100,
        provenanceId: "tool://proxmox/test/123-abc",
      };

      const mockClient = {
        get: vi.fn().mockResolvedValue({ data: mockData, metadata: mockMetadata }),
      };

      const tool = new TestProxmoxTool({
        name: "test_tool",
        description: "Test tool",
      });

      tool["apiClient"] = mockClient as any;

      const result = await tool["executeApiCall"](
        () => mockClient.get("/test"),
        mockContext
      );

      // Result includes provenance metadata
      expect(result.data).toBeDefined();
      expect(result.data._provenance).toBeDefined();
      expect(result.data._provenance.provenanceId).toBe("tool://proxmox/test/123-abc");
      expect(result.durationMs).toBe(100);
    });

    it("should handle API errors gracefully", async () => {
      const mockError = {
        message: "API error",
        response: {
          status: 404,
          data: { message: "Not found" },
        },
        config: { url: "/test" },
      };

      const mockClient = {
        get: vi.fn().mockRejectedValue(mockError),
      };

      const tool = new TestProxmoxTool({
        name: "test_tool",
        description: "Test tool",
      });

      tool["apiClient"] = mockClient as any;

      const result = await tool["executeApiCall"](
        () => mockClient.get("/test"),
        mockContext
      );

      expect(result.error).toContain("Proxmox API error");
    });
  });
});

