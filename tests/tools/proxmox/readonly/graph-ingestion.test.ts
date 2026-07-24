import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { extractProxmoxGraphEntities } from "../../../../src/tools/proxmox/readonly/graph-entity-extractor";
import { NodeType, RelationshipType } from "../../../../src/pce/kg/schema/ontology";

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
import { ProxmoxReadOnlyTool } from "../../../../src/tools/proxmox/readonly/proxmox-readonly-tool";

// Intercept ProxmoxReadOnlyTool at the prototype level (vi.spyOn), not by
// replacing its module (vi.mock) - under `bun test`, module mocks are
// process-global with no per-file teardown and leak into every other file
// that imports the real class (e.g.
// tests/tools/actions/execution-result.test.ts's loadTools(), which builds
// every registered tool and crashed reading .metadata off the plain
// {execute} object this used to wholesale-replace it with).
// vi.restoreAllMocks() properly undoes a prototype spy but not a module
// replacement.
const mockToolInstance = {
  execute: vi.fn(),
};
let executeSpy: { mockRestore: () => void };

describe("TL-2A.6.B: Graph Store Ingestion Validation", () => {
  beforeEach(() => {
    // vi.clearAllMocks() clears call history for every mock in the whole
    // process, not just this file's - under `bun test`, files run with real
    // concurrency, so it can zero out another file's still-in-flight spy
    // call count. Clear only this file's own mock.
    mockToolInstance.execute.mockClear();
    executeSpy = vi.spyOn(ProxmoxReadOnlyTool.prototype, "execute").mockImplementation(mockToolInstance.execute as any);
  });

  afterEach(() => {
    // vi.restoreAllMocks() restores every spy in the whole process, not just
    // this file's - under `bun test`, files run with real concurrency, so a
    // global restore can undo another file's still-in-flight spy on the same
    // shared prototype. Restore only the specific spy made here.
    executeSpy.mockRestore();
  });

  describe("Node Entity Extraction", () => {
    it("should extract PVE_NODE entities", async () => {
      mockToolInstance.execute.mockResolvedValue({
        data: {
          nodes: [
            {
              node: "pve1",
              status: "online",
              status_normalized: "online",
              cpu: 0.5,
              maxcpu: 8,
              mem: 8589934592,
              maxmem: 17179869184,
              uptime: 86400,
            },
            {
              node: "pve2",
              status: "online",
              status_normalized: "online",
              cpu: 0.3,
              maxcpu: 8,
              mem: 6442450944,
              maxmem: 17179869184,
              uptime: 86400,
            },
          ],
          count: 2,
        },
      });

      const { nodes, relationships } = await extractProxmoxGraphEntities();

      const nodeEntities = nodes.filter((n) => n.type === NodeType.PVE_NODE);
      expect(nodeEntities.length).toBe(2);
      expect(nodeEntities[0].id).toBe("pve_node:pve1");
      expect(nodeEntities[0].attributes.node).toBe("pve1");
      expect(nodeEntities[0].attributes.status).toBe("online");
      expect(nodeEntities[1].id).toBe("pve_node:pve2");
    });

    it("should include ACL metadata in nodes", async () => {
      mockToolInstance.execute.mockResolvedValue({
        data: {
          nodes: [{ node: "pve1", status: "online" }],
          count: 1,
        },
      });

      const { nodes } = await extractProxmoxGraphEntities("ops", "hash123", "/path/to/source");

      const node = nodes.find((n) => n.type === NodeType.PVE_NODE);
      expect(node?.aclGroup).toBe("ops");
      expect(node?.versionHash).toBe("hash123");
      expect(node?.sourcePath).toBe("/path/to/source");
    });
  });

  describe("VM Entity Extraction", () => {
    it("should extract VM_INSTANCE entities", async () => {
      mockToolInstance.execute
        .mockResolvedValueOnce({
          data: {
            nodes: [{ node: "pve1", status: "online" }],
            count: 1,
          },
        })
        .mockResolvedValueOnce({
          data: {
            vms: [
              {
                vmid: 101,
                name: "test-vm",
                status: "running",
                status_normalized: "running",
                type: "qemu",
                mem: 2147483648,
                maxmem: 4294967296,
                cpu: 0.2,
                uptime: 3600,
              },
            ],
            count: 1,
          },
        });

      const { nodes } = await extractProxmoxGraphEntities();

      const vmEntities = nodes.filter((n) => n.type === NodeType.VM_INSTANCE);
      expect(vmEntities.length).toBe(1);
      expect(vmEntities[0].id).toBe("vm_instance:101");
      expect(vmEntities[0].attributes.vmid).toBe(101);
      expect(vmEntities[0].attributes.name).toBe("test-vm");
      expect(vmEntities[0].attributes.node).toBe("pve1");
      expect(vmEntities[0].attributes.type).toBe("qemu");
      expect(vmEntities[0].attributes.status).toBe("running");
    });

    it("should handle multiple VMs on multiple nodes", async () => {
      mockToolInstance.execute
        .mockResolvedValueOnce({
          data: {
            nodes: [
              { node: "pve1", status: "online" },
              { node: "pve2", status: "online" },
            ],
            count: 2,
          },
        })
        .mockResolvedValueOnce({
          data: {
            vms: [{ vmid: 101, name: "vm1", status: "running", type: "qemu" }],
            count: 1,
          },
        })
        .mockResolvedValueOnce({
          data: {
            vms: [{ vmid: 102, name: "vm2", status: "running", type: "qemu" }],
            count: 1,
          },
        });

      const { nodes } = await extractProxmoxGraphEntities();

      const vmEntities = nodes.filter((n) => n.type === NodeType.VM_INSTANCE);
      expect(vmEntities.length).toBe(2);
      expect(vmEntities[0].attributes.node).toBe("pve1");
      expect(vmEntities[1].attributes.node).toBe("pve2");
    });
  });

  describe("Storage Entity Extraction", () => {
    it("should extract PVE_STORAGE entities", async () => {
      mockToolInstance.execute
        .mockResolvedValueOnce({
          data: {
            nodes: [{ node: "pve1", status: "online" }],
            count: 1,
          },
        })
        .mockResolvedValueOnce({
          data: { vms: [], count: 0 },
        })
        .mockResolvedValueOnce({
          data: {
            disks: [
              {
                devpath: "/dev/sda",
                type: "disk",
                size: 500107862016,
                model: "SSD",
              },
            ],
            count: 1,
          },
        });

      const { nodes } = await extractProxmoxGraphEntities();

      const storageEntities = nodes.filter((n) => n.type === NodeType.PVE_STORAGE);
      expect(storageEntities.length).toBeGreaterThan(0);
      const storage = storageEntities[0];
      expect(storage.type).toBe(NodeType.PVE_STORAGE);
      expect(storage.attributes.storage).toBeDefined();
    });
  });

  describe("Relationship Extraction", () => {
    it("should create VM RUNS_ON Node relationships", async () => {
      mockToolInstance.execute
        .mockResolvedValueOnce({
          data: {
            nodes: [{ node: "pve1", status: "online" }],
            count: 1,
          },
        })
        .mockResolvedValueOnce({
          data: {
            vms: [
              {
                vmid: 101,
                name: "test-vm",
                status: "running",
                type: "qemu",
              },
            ],
            count: 1,
          },
        });

      const { relationships } = await extractProxmoxGraphEntities();

      const runsOnRels = relationships.filter((r) => r.type === RelationshipType.RUNS_ON);
      expect(runsOnRels.length).toBe(1);
      expect(runsOnRels[0].from).toBe("vm_instance:101");
      expect(runsOnRels[0].to).toBe("pve_node:pve1");
      expect(runsOnRels[0].properties?.type).toBe("qemu");
    });

    it("should create Node CONNECTS_TO Node relationships (cluster ring)", async () => {
      mockToolInstance.execute.mockResolvedValue({
        data: {
          nodes: [
            { node: "pve1", status: "online" },
            { node: "pve2", status: "online" },
            { node: "pve3", status: "online" },
          ],
          count: 3,
        },
      });

      const { relationships } = await extractProxmoxGraphEntities();

      const connectsToRels = relationships.filter(
        (r) => r.type === RelationshipType.CONNECTS_TO
      );
      // 3 nodes = 3 choose 2 = 3 relationships
      expect(connectsToRels.length).toBe(3);
      expect(connectsToRels.some((r) => r.from === "pve_node:pve1" && r.to === "pve_node:pve2")).toBe(true);
      expect(connectsToRels.some((r) => r.from === "pve_node:pve1" && r.to === "pve_node:pve3")).toBe(true);
      expect(connectsToRels.some((r) => r.from === "pve_node:pve2" && r.to === "pve_node:pve3")).toBe(true);
    });

    it("should create Storage CONNECTED_TO Node relationships", async () => {
      mockToolInstance.execute
        .mockResolvedValueOnce({
          data: {
            nodes: [{ node: "pve1", status: "online" }],
            count: 1,
          },
        })
        .mockResolvedValueOnce({
          data: { vms: [], count: 0 },
        })
        .mockResolvedValueOnce({
          data: {
            disks: [
              {
                devpath: "/dev/sda",
                type: "disk",
              },
            ],
            count: 1,
          },
        });

      const { relationships } = await extractProxmoxGraphEntities();

      const connectedToRels = relationships.filter(
        (r) => r.type === RelationshipType.CONNECTED_TO
      );
      expect(connectedToRels.length).toBeGreaterThan(0);
      const rel = connectedToRels[0];
      expect(rel.to).toBe("pve_node:pve1");
      expect(rel.from).toContain("pve_storage:");
    });
  });

  describe("Entity Normalization", () => {
    it("should create consistent entity IDs", async () => {
      mockToolInstance.execute
        .mockResolvedValueOnce({
          data: {
            nodes: [{ node: "pve1", status: "online" }],
            count: 1,
          },
        })
        .mockResolvedValueOnce({
          data: {
            vms: [
              {
                vmid: 101,
                name: "test-vm",
                status: "running",
                type: "qemu",
              },
            ],
            count: 1,
          },
        });

      const { nodes } = await extractProxmoxGraphEntities();

      const node = nodes.find((n) => n.type === NodeType.PVE_NODE);
      const vm = nodes.find((n) => n.type === NodeType.VM_INSTANCE);

      expect(node?.id).toBe("pve_node:pve1");
      expect(vm?.id).toBe("vm_instance:101");
    });

    it("should not create duplicate entities", async () => {
      mockToolInstance.execute
        .mockResolvedValueOnce({
          data: {
            nodes: [{ node: "pve1", status: "online" }],
            count: 1,
          },
        })
        .mockResolvedValueOnce({
          data: {
            vms: [
              {
                vmid: 101,
                name: "test-vm",
                status: "running",
                type: "qemu",
              },
            ],
            count: 1,
          },
        })
        .mockResolvedValueOnce({
          data: {
            disks: [
              {
                devpath: "/dev/sda",
                type: "disk",
              },
            ],
            count: 1,
          },
        });

      const { nodes } = await extractProxmoxGraphEntities();

      const nodeIds = nodes.map((n) => n.id);
      const uniqueIds = new Set(nodeIds);
      expect(nodeIds.length).toBe(uniqueIds.size); // No duplicates
    });
  });

  describe("ACL Metadata", () => {
    it("should attach ACL metadata to all entities and relationships", async () => {
      mockToolInstance.execute
        .mockResolvedValueOnce({
          data: {
            nodes: [{ node: "pve1", status: "online" }],
            count: 1,
          },
        })
        .mockResolvedValueOnce({
          data: {
            vms: [
              {
                vmid: 101,
                name: "test-vm",
                status: "running",
                type: "qemu",
              },
            ],
            count: 1,
          },
        });

      const { nodes, relationships } = await extractProxmoxGraphEntities("admin", "hash123", "/source");

      // Check nodes have ACL metadata
      for (const node of nodes) {
        expect(node.aclGroup).toBe("admin");
        expect(node.versionHash).toBe("hash123");
        expect(node.sourcePath).toBe("/source");
      }

      // Check relationships have ACL metadata
      for (const rel of relationships) {
        expect(rel.aclGroup).toBe("admin");
        expect(rel.versionHash).toBe("hash123");
        expect(rel.sourcePath).toBe("/source");
      }
    });
  });

  describe("Error Handling", () => {
    it("should handle API errors gracefully", async () => {
      mockToolInstance.execute.mockResolvedValue({
        error: "API error",
      });

      await expect(extractProxmoxGraphEntities()).rejects.toThrow("Failed to list nodes");
    });

    it("should continue processing other nodes if one fails", async () => {
      mockToolInstance.execute
        .mockResolvedValueOnce({
          data: {
            nodes: [
              { node: "pve1", status: "online" },
              { node: "pve2", status: "online" },
            ],
            count: 2,
          },
        })
        .mockResolvedValueOnce({
          data: {
            vms: [{ vmid: 101, status: "running", type: "qemu" }],
            count: 1,
          },
        })
        .mockResolvedValueOnce({
          error: "Failed to get VMs for pve2",
        });

      // Should not throw, but continue processing
      const { nodes } = await extractProxmoxGraphEntities();

      // Should still have nodes and at least one VM
      expect(nodes.length).toBeGreaterThan(0);
    });
  });
});

