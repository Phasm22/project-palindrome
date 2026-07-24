import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  generateVmInventoryDocument,
  generateNodeProfileDocument,
  generateClusterStatusDocument,
  generateAllProxmoxDocuments,
} from "../../../../src/tools/proxmox/readonly/vector-document-generator";

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
import { ProxmoxReadOnlyTool } from "../../../../src/tools/proxmox/readonly/proxmox-readonly-tool";

// Intercept ProxmoxReadOnlyTool at the prototype level (vi.spyOn), not by
// replacing its module (vi.mock) - under `bun test`, module mocks are
// process-global with no per-file teardown and leak into every other file
// that imports the real class. vi.restoreAllMocks() properly undoes a
// prototype spy but not a module replacement.
const mockToolInstance = {
  execute: vi.fn(),
};
vi.spyOn(ProxmoxReadOnlyTool.prototype, "execute").mockImplementation(mockToolInstance.execute as any);

describe("TL-2A.6.A: Vector Store Ingestion Validation", () => {
  let mockClient: ProxmoxClient;

  beforeEach(() => {
    mockToolInstance.execute.mockReset();
    mockClient = {} as ProxmoxClient;
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe("VM Inventory Document Generation", () => {
    it("should generate VM inventory document with correct structure", async () => {
      mockToolInstance.execute.mockResolvedValue({
        data: {
          vms: [
            {
              vmid: 101,
              name: "test-vm-1",
              status: "running",
              status_normalized: "running",
              type: "qemu",
              mem_normalized: { value: 2, unit: "GB", raw: 2147483648 },
              maxmem_normalized: { value: 4, unit: "GB", raw: 4294967296 },
              cpu: 0.5,
              uptime_iso8601: "2024-01-01T00:00:00.000Z",
            },
            {
              vmid: 102,
              name: "test-vm-2",
              status: "stopped",
              status_normalized: "stopped",
              type: "qemu",
            },
          ],
          count: 2,
        },
      });

      const doc = await generateVmInventoryDocument(mockClient, "pve1");

      expect(doc.content).toContain("# VM Inventory for Node: pve1");
      expect(doc.content).toContain("VM 101: test-vm-1");
      expect(doc.content).toContain("VM 102: test-vm-2");
      expect(doc.content).toContain("Status: running");
      expect(doc.content).toContain("Status: stopped");
      expect(doc.metadata.documentType).toBe("vm_inventory");
      expect(doc.metadata.node).toBe("pve1");
      expect(doc.metadata.source).toBe("proxmox");
    });

    it("should handle empty VM list", async () => {
      mockToolInstance.execute.mockResolvedValue({
        data: {
          vms: [],
          count: 0,
        },
      });

      const doc = await generateVmInventoryDocument(mockClient, "pve1");

      expect(doc.content).toContain("Total VMs: 0");
      expect(doc.metadata.documentType).toBe("vm_inventory");
    });

    it("degrades to an empty VM list on API failure instead of throwing", async () => {
      // generateVmInventoryDocument catches execute() failures per-call (qemu/lxc
      // fetched independently via Promise.all) and falls back to an empty vms
      // list for whichever call failed, rather than propagating an error - this
      // keeps one broken VM type from blocking the whole document.
      mockToolInstance.execute.mockResolvedValue({
        error: "API error",
      });

      const doc = await generateVmInventoryDocument(mockClient, "pve1");

      expect(doc.content).toContain("Total VMs: 0");
    });
  });

  describe("Node Profile Document Generation", () => {
    it("should generate node profile document with correct structure", async () => {
      // generateNodeProfileDocument makes a single node_status execute() call
      // and reads status/memory/cpu all off that one response (node_resources
      // was folded into node_status and removed as a separate action).
      mockToolInstance.execute.mockResolvedValueOnce({
        data: {
          node: "pve1",
          status: "online",
          status_normalized: "online",
          uptime_iso8601: "2024-01-01T00:00:00.000Z",
          kversion: "5.15.0",
          pveversion: "8.0.0",
          memory: {
            used_normalized: { value: 8, unit: "GB", raw: 8589934592 },
            total_normalized: { value: 16, unit: "GB", raw: 17179869184 },
          },
          cpu: {
            usage: 0.5,
            cores: 8,
          },
        },
      });

      const doc = await generateNodeProfileDocument(mockClient, "pve1");

      expect(doc.content).toContain("# Node Resource Profile: pve1");
      expect(doc.content).toContain("Status: online");
      expect(doc.content).toContain("Used: 8 GB");
      expect(doc.content).toContain("Total: 16 GB");
      expect(doc.content).toContain("Usage: 50.0%");
      expect(doc.content).toContain("Cores: 8");
      expect(doc.metadata.documentType).toBe("node_profile");
      expect(doc.metadata.node).toBe("pve1");
    });
  });

  describe("Cluster Status Document Generation", () => {
    it("should generate cluster status document with correct structure", async () => {
      mockToolInstance.execute
        .mockResolvedValueOnce({
          data: {
            nodes: [
              { node: "pve1", status: "online", status_normalized: "online" },
              { node: "pve2", status: "online", status_normalized: "online" },
            ],
            count: 2,
          },
        })
        .mockResolvedValueOnce({
          data: {
            quorum: {
              quorate: true,
              votes: 2,
              expected_votes: 2,
            },
            nodes: [
              { name: "pve1", online: true, local: true },
              { name: "pve2", online: true, local: false },
            ],
          },
        })
        .mockResolvedValueOnce({
          data: {
            resources: [
              { id: "qemu/101", status: "running" },
              { id: "qemu/102", status: "stopped" },
            ],
            count: 2,
          },
        });

      const doc = await generateClusterStatusDocument(mockClient);

      expect(doc.content).toContain("# Cluster Status Summary");
      expect(doc.content).toContain("Status: OK");
      expect(doc.content).toContain("Votes: 2 / 2");
      expect(doc.content).toContain("Total Nodes: 2");
      expect(doc.content).toContain("Running VMs: 1");
      expect(doc.content).toContain("Stopped VMs: 1");
      expect(doc.metadata.documentType).toBe("cluster_status");
    });
  });

  describe("All Documents Generation", () => {
    it("should generate all documents for a cluster", async () => {
      mockToolInstance.execute
        .mockResolvedValueOnce({
          data: {
            nodes: [
              { node: "pve1", status: "online" },
            ],
            count: 1,
          },
        })
        .mockResolvedValueOnce({
          data: {
            quorum: { quorate: true, votes: 1, expected_votes: 1 },
            nodes: [{ name: "pve1", online: true }],
          },
        })
        .mockResolvedValueOnce({
          data: { resources: [], count: 0 },
        })
        .mockResolvedValueOnce({
          data: {
            node: "pve1",
            status: "online",
            uptime_iso8601: "2024-01-01T00:00:00.000Z",
          },
        })
        .mockResolvedValueOnce({
          data: {
            node: "pve1",
            memory: { used_normalized: { value: 8, unit: "GB" }, total_normalized: { value: 16, unit: "GB" } },
            cpu: { usage: 0.5, cores: 8 },
          },
        })
        .mockResolvedValueOnce({
          data: { vms: [], count: 0 },
        })
        // generateVmInventoryDocument fetches qemu and lxc VMs as two separate
        // execute() calls (Promise.all) - this persistent fallback covers
        // whichever of the two isn't served by the queued value above, instead
        // of falling through to an unconfigured vi.fn() returning undefined.
        .mockResolvedValue({
          data: { vms: [], count: 0 },
        });

      const docs = await generateAllProxmoxDocuments(mockClient);

      expect(docs.length).toBeGreaterThan(0);
      expect(docs.some((d) => d.metadata.documentType === "cluster_status")).toBe(true);
      expect(docs.some((d) => d.metadata.documentType === "node_profile")).toBe(true);
      expect(docs.some((d) => d.metadata.documentType === "vm_inventory")).toBe(true);
    });
  });

  describe("Document Content Quality", () => {
    it("should generate documents with searchable content", async () => {
      mockToolInstance.execute.mockResolvedValue({
        data: {
          vms: [
            {
              vmid: 101,
              name: "web-server",
              status: "running",
              status_normalized: "running",
              type: "qemu",
              mem_normalized: { value: 2, unit: "GB" },
              maxmem_normalized: { value: 4, unit: "GB" },
            },
          ],
          count: 1,
        },
      });

      const doc = await generateVmInventoryDocument(mockClient, "pve1");

      // Verify content is searchable
      expect(doc.content).toContain("web-server");
      expect(doc.content).toContain("VM 101");
      expect(doc.content).toContain("running");
      expect(doc.content).toContain("2 GB");
      expect(doc.content.length).toBeGreaterThan(100); // Substantial content
    });

    it("should include metadata for filtering", async () => {
      mockToolInstance.execute.mockResolvedValue({
        data: { vms: [], count: 0 },
      });

      const doc = await generateVmInventoryDocument(mockClient, "pve1");

      expect(doc.metadata).toHaveProperty("documentType");
      expect(doc.metadata).toHaveProperty("source");
      expect(doc.metadata).toHaveProperty("timestamp");
      expect(doc.metadata).toHaveProperty("node");
    });
  });
});

