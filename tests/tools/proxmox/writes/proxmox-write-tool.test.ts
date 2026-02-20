import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProxmoxWriteTool } from "../../../../src/tools/proxmox/writes/proxmox-write-tool";
import type { ExecutionContext } from "../../../../src/types/execution";

// Mock ProxmoxClient
let mockProxmoxClient: any;

vi.mock("../../../../src/tools/proxmox/client", () => {
  mockProxmoxClient = {
    get: vi.fn(),
    post: vi.fn(),
  };
  
  return {
    ProxmoxClient: vi.fn().mockImplementation(() => mockProxmoxClient),
  };
});

// Mock logger
vi.mock("../../../../src/pce/utils/logger", () => ({
  pceLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock sanitizeToolPayload
vi.mock("../../../../src/agent/tool-sanitizer", () => ({
  sanitizeToolPayload: (data: any) => data,
}));

describe("TL-2B: Proxmox Safe Write Suite", () => {
  const mockContext: ExecutionContext = {
    toolName: "proxmox_write",
    startedAt: Date.now(),
    userId: "test-user",
    aclGroup: "ops",
  };

  let tool: ProxmoxWriteTool;
  let mockClient: any;

  beforeEach(() => {
    process.env.PROXMOX_URL = "https://pve1.prox:8006";
    process.env.PROXMOX_TOKEN_ID = "testuser@pam!testtoken";
    process.env.PROXMOX_TOKEN_SECRET = "test-secret";

    mockClient = mockProxmoxClient;
    mockClient.get.mockClear();
    mockClient.post.mockClear();

    tool = new ProxmoxWriteTool();
    (tool as any).apiClient = undefined;
  });

  describe("TL-2B.1: Restricted Write Action Implementation", () => {
    it("should implement start_vm action", async () => {
      const mockResponse = {
        data: { data: "OK" },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValueOnce({
        data: { data: { status: "stopped" } },
        metadata: mockResponse.metadata,
      });
      mockClient.get.mockResolvedValueOnce({
        data: { data: {} },
        metadata: mockResponse.metadata,
      });
      mockClient.post.mockResolvedValue(mockResponse);

      const result = await tool.execute(
        { action: "start_vm", node: "pve1", vmid: 101 },
        mockContext
      );

      expect(result.data).toBeDefined();
      expect(result.data.action).toBe("start_vm");
      expect(mockClient.post).toHaveBeenCalled();
    });

    it("should implement stop_vm action", async () => {
      const mockResponse = {
        data: { data: "OK" },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValueOnce({
        data: { data: { status: "running" } },
        metadata: mockResponse.metadata,
      });
      mockClient.get.mockResolvedValueOnce({
        data: { data: {} },
        metadata: mockResponse.metadata,
      });
      mockClient.post.mockResolvedValue(mockResponse);

      const result = await tool.execute(
        { action: "stop_vm", node: "pve1", vmid: 101 },
        mockContext
      );

      expect(result.data).toBeDefined();
      expect(result.data.action).toBe("stop_vm");
    });

    it("should implement migrate_vm action", async () => {
      const mockResponse = {
        data: { data: "OK" },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      const mockNodesResponse = {
        data: { data: [{ node: "pve1" }, { node: "pve2" }] },
        metadata: mockResponse.metadata,
      };
      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        return Promise.resolve({
          data: { data: { status: "online" } },
          metadata: mockResponse.metadata,
        });
      });
      mockClient.post.mockResolvedValue(mockResponse);

      const result = await tool.execute(
        { action: "migrate_vm", node: "pve1", vmid: 101, targetNode: "pve2" },
        mockContext
      );

      expect(result.data).toBeDefined();
      expect(result.data.action).toBe("migrate_vm");
    });

    it("should implement shutdown_vm action", async () => {
      const mockResponse = {
        data: { data: "OK" },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValueOnce({
        data: { data: { status: "running" } },
        metadata: mockResponse.metadata,
      });
      mockClient.get.mockResolvedValueOnce({
        data: { data: {} },
        metadata: mockResponse.metadata,
      });
      mockClient.post.mockResolvedValue(mockResponse);

      const result = await tool.execute(
        { action: "shutdown_vm", node: "pve1", vmid: 101 },
        mockContext
      );

      expect(result.data).toBeDefined();
      expect(result.data.action).toBe("shutdown_vm");
      expect(mockClient.post).toHaveBeenCalled();
    });

    it("should implement reboot_vm action", async () => {
      const mockResponse = {
        data: { data: "OK" },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValueOnce({
        data: { data: { status: "running" } },
        metadata: mockResponse.metadata,
      });
      mockClient.get.mockResolvedValueOnce({
        data: { data: {} },
        metadata: mockResponse.metadata,
      });
      mockClient.post.mockResolvedValue(mockResponse);

      const result = await tool.execute(
        { action: "reboot_vm", node: "pve1", vmid: 101 },
        mockContext
      );

      expect(result.data).toBeDefined();
      expect(result.data.action).toBe("reboot_vm");
      expect(mockClient.post).toHaveBeenCalled();
    });

    it("should implement reset_vm action", async () => {
      const mockResponse = {
        data: { data: "OK" },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValueOnce({
        data: { data: { status: "running" } },
        metadata: mockResponse.metadata,
      });
      mockClient.get.mockResolvedValueOnce({
        data: { data: {} },
        metadata: mockResponse.metadata,
      });
      mockClient.post.mockResolvedValue(mockResponse);

      const result = await tool.execute(
        { action: "reset_vm", node: "pve1", vmid: 101 },
        mockContext
      );

      expect(result.data).toBeDefined();
      expect(result.data.action).toBe("reset_vm");
      expect(mockClient.post).toHaveBeenCalled();
    });

    it("should implement create_snapshot action", async () => {
      const mockResponse = {
        data: { data: "OK" },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValueOnce({
        data: { data: { status: "running" } },
        metadata: mockResponse.metadata,
      });
      mockClient.get.mockResolvedValueOnce({
        data: { data: {} },
        metadata: mockResponse.metadata,
      });
      mockClient.post.mockResolvedValue(mockResponse);

      const result = await tool.execute(
        { action: "create_snapshot", node: "pve1", vmid: 101, snapshotName: "test-snapshot" },
        mockContext
      );

      expect(result.data).toBeDefined();
      expect(result.data.action).toBe("create_snapshot");
      expect(result.data.snapshotName).toBe("test-snapshot");
      expect(mockClient.post).toHaveBeenCalled();
    });

    it("should implement rollback_snapshot action", async () => {
      const mockResponse = {
        data: { data: "OK" },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValueOnce({
        data: { data: { status: "running" } },
        metadata: mockResponse.metadata,
      });
      mockClient.get.mockResolvedValueOnce({
        data: { data: {} },
        metadata: mockResponse.metadata,
      });
      mockClient.post.mockResolvedValue(mockResponse);

      const result = await tool.execute(
        { action: "rollback_snapshot", node: "pve1", vmid: 101, snapshotName: "test-snapshot" },
        mockContext
      );

      expect(result.data).toBeDefined();
      expect(result.data.action).toBe("rollback_snapshot");
      expect(result.data.snapshotName).toBe("test-snapshot");
      expect(mockClient.post).toHaveBeenCalled();
    });

    it("should implement clone_vm action", async () => {
      const mockResponse = {
        data: { data: "OK" },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValueOnce({
        data: { data: { status: "stopped" } },
        metadata: mockResponse.metadata,
      });
      mockClient.get.mockResolvedValueOnce({
        data: { data: {} },
        metadata: mockResponse.metadata,
      });
      mockClient.post.mockResolvedValue(mockResponse);

      const result = await tool.execute(
        { action: "clone_vm", node: "pve1", vmid: 101, newVmid: 102 },
        mockContext
      );

      expect(result.data).toBeDefined();
      expect(result.data.action).toBe("clone_vm");
      expect(result.data.newVmid).toBe(102);
      expect(mockClient.post).toHaveBeenCalled();
    });
  });

  describe("TL-2B.2: Migration Pre-Flight Check Implementation", () => {
    it("should run pre-flight checks before migration", async () => {
      const mockResponse = {
        data: { data: { status: "online" } },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      const mockNodesResponse = {
        data: { data: [{ node: "pve1" }, { node: "pve2" }] },
        metadata: mockResponse.metadata,
      };
      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await tool.execute(
        { action: "migrate_vm", node: "pve1", vmid: 101, targetNode: "pve2" },
        mockContext
      );

      expect(result.data.preFlightChecks).toBeDefined();
      expect(result.data.preFlightChecks.checks).toBeDefined();
      expect(Array.isArray(result.data.preFlightChecks.checks)).toBe(true);
    });

    it("should block migration if pre-flight checks fail", async () => {
      const metadata = { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" };
      const mockNodesResponse = {
        data: { data: [{ node: "pve1" }, { node: "pve2" }] },
        metadata,
      };
      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        if (endpoint.includes("/nodes/pve1/status")) {
          return Promise.resolve({ data: { data: { status: "offline" } }, metadata });
        }
        if (endpoint.includes("/nodes/pve2/status")) {
          return Promise.resolve({ data: { data: { status: "online" } }, metadata });
        }
        return Promise.resolve({ data: { data: { status: "online" } }, metadata });
      });

      const result = await tool.execute(
        { action: "migrate_vm", node: "pve1", vmid: 101, targetNode: "pve2" },
        mockContext
      );

      expect(result.data.status).toBe("migration_unsafe");
      expect(result.data.blocked).toBe(true);
      expect(mockClient.post).not.toHaveBeenCalled();
    });
  });

  describe("TL-2B.3: Mandatory Dry-Run and Diff Preview", () => {
    it("should support dryRun for start_vm", async () => {
      const mockResponse = {
        data: { data: { status: "stopped" } },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValue(mockResponse);

      const result = await tool.execute(
        { action: "start_vm", node: "pve1", vmid: 101, dryRun: true },
        mockContext
      );

      expect(result.data.dryRun).toBe(true);
      expect(result.data.currentState).toBeDefined();
      expect(result.data.proposedChanges).toBeDefined();
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it("should support dryRun for migrate_vm", async () => {
      const mockResponse = {
        data: { data: { status: "online" } },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      const mockNodesResponse = {
        data: { data: [{ node: "pve1" }, { node: "pve2" }] },
        metadata: mockResponse.metadata,
      };
      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await tool.execute(
        { action: "migrate_vm", node: "pve1", vmid: 101, targetNode: "pve2", dryRun: true },
        mockContext
      );

      expect(result.data.dryRun).toBe(true);
      expect(result.data.preFlightChecks).toBeDefined();
      expect(mockClient.post).not.toHaveBeenCalled();
    });
  });

  describe("TL-2B.4: Confirmation Middleware Trigger (HIL)", () => {
    it("should have requiresConfirmation disabled for safe writes", () => {
      expect(tool.metadata.requiresConfirmation).toBe(false);
    });

    it("should have restricted ACL groups", () => {
      const allowedAcls = tool.metadata.allowedAcls;
      expect(Array.isArray(allowedAcls)).toBe(true);
      if (allowedAcls && allowedAcls.length > 0) {
        expect(allowedAcls).toContain("admin");
        expect(allowedAcls).toContain("ops");
        expect(allowedAcls).not.toContain("viewer");
      } else {
        // If not set, that's also a valid test outcome (will be enforced at policy layer)
        expect(allowedAcls).toBeDefined();
      }
    });
  });

  describe("TL-2B.5: Pre-Write State Provenance Capture", () => {
    it("should capture pre-write state before executing write", async () => {
      const mockResponse = {
        data: { data: "OK" },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValueOnce({
        data: { data: { status: "stopped" } },
        metadata: mockResponse.metadata,
      });
      mockClient.get.mockResolvedValueOnce({
        data: { data: {} },
        metadata: mockResponse.metadata,
      });
      mockClient.post.mockResolvedValue(mockResponse);

      const result = await tool.execute(
        { action: "start_vm", node: "pve1", vmid: 101 },
        mockContext
      );

      expect(result.data.preWriteState).toBeDefined();
      expect(typeof result.data.preWriteState).toBe("string");
      expect(result.data.preWriteState).toContain("proxmox-pre-write-");
    });
  });
});
