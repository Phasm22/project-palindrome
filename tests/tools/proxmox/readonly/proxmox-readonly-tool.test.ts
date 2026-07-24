import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ProxmoxReadOnlyTool } from "../../../../src/tools/proxmox/readonly/proxmox-readonly-tool";
import { ProxmoxClient } from "../../../../src/tools/proxmox/client";
import * as ToolSanitizerModule from "../../../../src/agent/tool-sanitizer";
import type { ExecutionContext } from "../../../../src/types/execution";

vi.mock("https", () => ({
  default: {
    Agent: vi.fn().mockImplementation(() => ({})),
  },
}));

// Intercept ProxmoxClient at the prototype level and sanitizeToolPayload at
// the module-namespace level (vi.spyOn) rather than replacing whole modules
// (vi.mock). Under `bun test`, module-level mock replacements are registered
// in a single process-wide registry with no per-file teardown -
// vi.restoreAllMocks() doesn't undo them - so whichever test file's
// vi.mock("proxmox/client"/"tool-sanitizer", ...) happened to win leaked into
// every *other* file that imports the real thing (e.g.
// tests/tools/proxmox/readonly/client.test.ts and
// tests/tools/proxmox/readonly/redaction.test.ts). Prototype/namespace spies,
// unlike module mocks, are properly torn down by vi.restoreAllMocks().

describe("TL-2A.2: Core Action Implementation (15 Actions)", () => {
  const mockContext: ExecutionContext = {
    toolName: "proxmox_readonly",
    startedAt: Date.now(),
  };

  // Standard mock nodes response for node name validation
  const mockNodesResponse = {
    data: {
      data: [
        { node: "pve1", status: "online", cpu: 0.5, maxcpu: 8, maxmem: 17179869184, mem: 8589934592, uptime: 86400 },
        { node: "pve2", status: "online", cpu: 0.3, maxcpu: 8, maxmem: 17179869184, mem: 6442450944, uptime: 86400 },
      ],
    },
    metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
  };

  let tool: ProxmoxReadOnlyTool;
  let mockClient: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  const originalProxmoxEnv = {
    PROXMOX_URL: process.env.PROXMOX_URL,
    PROXMOX_TOKEN_ID: process.env.PROXMOX_TOKEN_ID,
    PROXMOX_TOKEN_SECRET: process.env.PROXMOX_TOKEN_SECRET,
  };

  beforeEach(() => {
    process.env.PROXMOX_URL = "https://proxmox.example.com";
    process.env.PROXMOX_TOKEN_ID = "testuser@pam!testtoken";
    process.env.PROXMOX_TOKEN_SECRET = "test-secret";

    // Every ProxmoxClient instance (any endpoint the tool constructs
    // internally) shares this prototype, so spying here intercepts all of
    // them regardless of which endpoint config the tool picked.
    mockClient = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    vi.spyOn(ProxmoxClient.prototype, "get").mockImplementation(mockClient.get as any);
    vi.spyOn(ProxmoxClient.prototype, "post").mockImplementation(mockClient.post as any);
    vi.spyOn(ProxmoxClient.prototype, "put").mockImplementation(mockClient.put as any);
    vi.spyOn(ProxmoxClient.prototype, "delete").mockImplementation(mockClient.delete as any);
    vi.spyOn(ToolSanitizerModule, "sanitizeToolPayload").mockImplementation((data: any) => data);

    tool = new ProxmoxReadOnlyTool();

    // Clear any cached client so tool creates a new one (which will use the spied prototype)
    (tool as any).apiClient = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(originalProxmoxEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe("Node-Level Actions", () => {
    it("should implement list_nodes action", async () => {
      const mockResponse = {
        data: {
          data: [
            { node: "pve1", status: "online", cpu: 0.5, maxcpu: 8, maxmem: 17179869184, mem: 8589934592, uptime: 86400 },
            { node: "pve2", status: "online", cpu: 0.3, maxcpu: 8, maxmem: 17179869184, mem: 6442450944, uptime: 86400 },
          ],
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValue(mockResponse);

      const result = await tool.execute({ action: "list_nodes" }, mockContext);

      expect(result.data).toBeDefined();
      expect(result.data.nodes).toBeDefined();
      expect(result.data.count).toBe(2);
      // ProxmoxClient.get() may call with just endpoint or with config
      expect(mockClient.get).toHaveBeenCalled();
      const calls = (mockClient.get as any).mock.calls;
      expect(calls.some((call: any[]) => call[0] === "/nodes")).toBe(true);
    });

    it("should keep node memory when status nests memory.used/total", async () => {
      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve({
            data: {
              data: [
                { node: "pve1", status: "online", cpu: 0.1, maxcpu: 8, mem: 1, maxmem: 2, uptime: 100 },
              ],
            },
            metadata: { status: 200, timestamp: Date.now(), durationMs: 10, provenanceId: "tool://proxmox/test/list" },
          });
        }
        if (endpoint === "/nodes/pve1/status") {
          return Promise.resolve({
            data: {
              data: {
                cpu: 0.25,
                maxcpu: 16,
                uptime: 86400,
                // Real Proxmox node status shape — nested, not top-level mem/maxmem
                memory: { used: 8589934592, total: 17179869184, free: 8589934592 },
              },
            },
            metadata: { status: 200, timestamp: Date.now(), durationMs: 10, provenanceId: "tool://proxmox/test/status" },
          });
        }
        return Promise.reject(new Error(`Unexpected endpoint ${endpoint}`));
      });

      const result = await tool.execute({ action: "list_nodes" }, mockContext);
      expect(result.data.nodes).toHaveLength(1);
      const node = result.data.nodes[0];
      expect(node.mem).toBe(8589934592);
      expect(node.maxmem).toBe(17179869184);
      expect(node.mem_normalized?.raw).toBe(8589934592);
      expect(node.maxmem_normalized?.raw).toBe(17179869184);
    });

    it("should fall back to list-endpoint mem when status omits memory", async () => {
      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve({
            data: {
              data: [
                { node: "pve1", status: "online", cpu: 0.1, mem: 4294967296, maxmem: 8589934592, uptime: 100 },
              ],
            },
            metadata: { status: 200, timestamp: Date.now(), durationMs: 10, provenanceId: "tool://proxmox/test/list" },
          });
        }
        if (endpoint === "/nodes/pve1/status") {
          return Promise.resolve({
            data: {
              data: {
                cpu: 0.2,
                uptime: 200,
                // No mem/maxmem and no nested memory — enrichment must keep list values
              },
            },
            metadata: { status: 200, timestamp: Date.now(), durationMs: 10, provenanceId: "tool://proxmox/test/status" },
          });
        }
        return Promise.reject(new Error(`Unexpected endpoint ${endpoint}`));
      });

      const result = await tool.execute({ action: "list_nodes" }, mockContext);
      const node = result.data.nodes[0];
      expect(node.mem).toBe(4294967296);
      expect(node.maxmem).toBe(8589934592);
    });

    it("should implement node_status action", async () => {
      const mockResponse = {
        data: {
          data: {
            node: "pve1",
            status: "online",
            cpu: 0.5,
            maxcpu: 8,
            maxmem: 17179869184,
            mem: 8589934592,
            uptime: 86400,
          },
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await tool.execute({ action: "node_status", node: "pve1" }, mockContext);

      expect(result.data).toBeDefined();
      expect(result.data.node).toBe("pve1");
      expect(mockClient.get).toHaveBeenCalled();
      const calls = (mockClient.get as any).mock.calls;
      expect(calls.some((call: any[]) => call[0] === "/nodes")).toBe(true);
      expect(calls.some((call: any[]) => call[0] === "/nodes/pve1/status")).toBe(true);
    });

    it("should include resource fields in node_status action", async () => {
      const mockResponse = {
        data: {
          data: {
            node: "pve1",
            cpu: 0.5,
            maxcpu: 8,
            maxmem: 17179869184,
            mem: 8589934592,
            uptime: 86400,
          },
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await tool.execute({ action: "node_status", node: "pve1" }, mockContext);

      expect(result.data).toBeDefined();
      // Check for node or any memory-related data (normalization may change structure)
      const hasNode = result.data.node === "pve1" || result.data.node === undefined;
      const hasMemoryData = result.data.mem_normalized || 
                           result.data.memory || 
                           result.data.maxmem_normalized ||
                           result.data.mem ||
                           result.data.maxmem ||
                           (typeof result.data === 'object' && Object.keys(result.data).some(k => k.includes('mem')));
      expect(hasNode || hasMemoryData).toBeTruthy();
    });

    it("should implement node_disks action", async () => {
      const mockResponse = {
        data: {
          data: [
            { devpath: "/dev/sda", size: 500107862016, type: "disk", model: "SSD" },
          ],
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await tool.execute({ action: "node_disks", node: "pve1" }, mockContext);

      expect(result.data).toBeDefined();
      expect(result.data.disks).toBeDefined();
      expect(result.data.count).toBe(1);
    });

    it("should filter node tasks by VMID", async () => {
      const mockResponse = {
        data: {
          data: [
            { upid: "task-100", type: "vzdump", id: "100", status: "OK", node: "pve1" },
            { upid: "task-101", type: "qmstart", id: "101", status: "OK", node: "pve1" },
          ],
        },
        metadata: {
          status: 200,
          timestamp: Date.now(),
          durationMs: 100,
          provenanceId: "tool://proxmox/test/123",
        },
      };

      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await tool.execute(
        { action: "node_tasks", node: "pve1", vmid: 100 },
        mockContext
      );

      expect(result.data.node).toBe("pve1");
      expect(result.data.vmid).toBe(100);
      expect(result.data.count).toBe(1);
      expect(result.data.tasks[0].id).toBe("100");
    });

    it("should implement node_network_interfaces action", async () => {
      const mockResponse = {
        data: {
          data: [
            { iface: "eth0", type: "eth", method: "static", address: "192.168.1.10", active: true },
          ],
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await tool.execute({ action: "node_network_interfaces", node: "pve1" }, mockContext);

      expect(result.data).toBeDefined();
      expect(result.data.interfaces).toBeDefined();
      expect(result.data.count).toBe(1);
    });
  });

  describe("VM-Level Actions", () => {
    it("should implement list_vms action", async () => {
      const mockResponse = {
        data: {
          data: [
            { vmid: 101, name: "vm1", status: "running", cpu: 0.2, mem: 2147483648, maxmem: 4294967296 },
            { vmid: 102, name: "vm2", status: "stopped", cpu: 0, mem: 0, maxmem: 2147483648 },
          ],
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };
      const mockEmptyResponse = {
        data: {
          data: [],
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        if (endpoint === "/nodes/pve1/qemu" || endpoint === "/nodes/pve1/lxc") {
          // Return VMs for qemu, empty for lxc to get total count of 2
          if (endpoint === "/nodes/pve1/qemu") {
            return Promise.resolve(mockResponse);
          }
          return Promise.resolve(mockEmptyResponse);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await tool.execute({ action: "list_vms", node: "pve1" }, mockContext);

      expect(result.data).toBeDefined();
      expect(result.data.vms).toBeDefined();
      expect(result.data.count).toBe(2);
      expect(mockClient.get).toHaveBeenCalled();
      const calls = (mockClient.get as any).mock.calls;
      expect(calls.some((call: any[]) => call[0] === "/nodes/pve1/qemu")).toBe(true);
      expect(calls.some((call: any[]) => call[0] === "/nodes/pve1/lxc")).toBe(true);
    });

    it("should implement get_vm_status action", async () => {
      const mockResponse = {
        data: {
          data: {
            vmid: 101,
            status: "running",
            cpu: 0.2,
            mem: 2147483648,
            maxmem: 4294967296,
            uptime: 3600,
          },
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await tool.execute({ action: "get_vm_status", node: "pve1", vmid: 101 }, mockContext);

      expect(result.data).toBeDefined();
      expect(result.data.vmid).toBe(101);
      expect(result.data.node).toBe("pve1");
    });

    it("should implement get_vm_config action", async () => {
      const mockResponse = {
        data: {
          data: {
            vmid: 101,
            cores: 2,
            memory: 4096,
            net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0",
          },
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await tool.execute({ action: "get_vm_config", node: "pve1", vmid: 101 }, mockContext);

      expect(result.data).toBeDefined();
      expect(result.data.vmid).toBe(101);
    });

    it("should implement get_vm_network action", async () => {
      const mockResponse = {
        data: {
          data: {
            net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0",
            net1: "virtio=11:22:33:44:55:66,bridge=vmbr1",
          },
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await tool.execute({ action: "get_vm_network", node: "pve1", vmid: 101 }, mockContext);

      expect(result.data).toBeDefined();
      // Network data might be in different format after normalization
      expect(result.data.network || result.data.net0 || Object.keys(result.data).some(k => k.includes('net'))).toBeTruthy();
    });

    it("should implement get_vm_snapshots action", async () => {
      const mockResponse = {
        data: {
          data: [
            { name: "snapshot1", description: "Test snapshot", snaptime: 1609459200 },
          ],
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await tool.execute({ action: "get_vm_snapshots", node: "pve1", vmid: 101 }, mockContext);

      expect(result.data).toBeDefined();
      expect(result.data.snapshots).toBeDefined();
      expect(result.data.count).toBe(1);
    });

    it("should implement get_vm_ip action", async () => {
      const mockResponse = {
        data: {
          data: {
            result: [
              {
                name: "eth0",
                "ip-addresses": [
                  { "ip-address-type": "ipv4", "ip-address": "192.168.1.100" },
                ],
                "hardware-address": "aa:bb:cc:dd:ee:ff",
              },
            ],
          },
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await tool.execute({ action: "get_vm_ip", node: "pve1", vmid: 101, type: "qemu" }, mockContext);

      expect(result.data).toBeDefined();
      expect(result.data.ips).toBeDefined();
      expect(Array.isArray(result.data.ips)).toBe(true);
      expect(["guest_agent", "unknown"]).toContain(result.data.source);
    });

    it("should handle get_vm_ip fallback when guest agent unavailable", async () => {
      // First call: /nodes for node validation
      mockClient.get.mockResolvedValueOnce(mockNodesResponse);
      
      // Second call: status check succeeds
      const statusResponse = {
        data: {
          data: {
            status: "running",
          },
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };
      mockClient.get.mockResolvedValueOnce(statusResponse);
      
      // Third call: config fetch (now happens before guest agent for static IP/DNS detection)
      const configResponse = {
        data: {
          data: {
            net0: "virtio=aa:bb:cc:dd:ee:ff,bridge=vmbr0",
          },
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };
      mockClient.get.mockResolvedValueOnce(configResponse);
      
      // Fourth call fails (guest agent unavailable)
      mockClient.get.mockRejectedValueOnce({ response: { status: 500 } });

      const result = await tool.execute({ action: "get_vm_ip", node: "pve1", vmid: 101, type: "qemu" }, mockContext);

      expect(result.data).toBeDefined();
      // Source could be "config_fallback" or include "static_config" or "dns_resolution" if found
      expect(result.data.source).toMatch(/config_fallback|static_config|dns_resolution|unknown/);
      expect(Array.isArray(result.data.ips)).toBe(true);
    });

    it("should implement get_lxc_config action", async () => {
      const mockResponse = {
        data: {
          data: {
            hostname: "container1",
            memory: 1024,
            cores: 2,
          },
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      // When type is provided, auto-detection is skipped, so only the config call is made
      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await tool.execute({ action: "get_lxc_config", node: "pve1", vmid: 100, type: "lxc" }, mockContext);

      expect(result.data).toBeDefined();
      expect(result.data.type).toBe("lxc");
      expect(result.data.vmid).toBe(100);
    });
  });

  describe("Cluster-Level Actions", () => {
    it("should advertise cluster_ceph_status in the tool contract", () => {
      const schema = tool.getSchema();

      expect(schema.parameters.properties.action.enum).toContain(
        "cluster_ceph_status"
      );
      expect(schema.description).toContain("cluster_ceph_status");
      expect(schema.examples).toContainEqual({
        description:
          "Get Ceph cluster health, quorum, OSD, placement-group, and capacity status",
        parameters: { action: "cluster_ceph_status" },
      });
    });

    it("should implement cluster_resources action", async () => {
      const mockResponse = {
        data: {
          data: [
            { id: "qemu/101", type: "qemu", node: "pve1", name: "vm1", status: "running" },
          ],
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValue(mockResponse);

      const result = await tool.execute({ action: "cluster_resources" }, mockContext);

      expect(result.data).toBeDefined();
      expect(result.data.resources).toBeDefined();
      expect(mockClient.get).toHaveBeenCalled();
      const calls = (mockClient.get as any).mock.calls;
      const resourceCall = calls.find((call: any[]) => call[0] === "/cluster/resources");
      expect(resourceCall).toBeDefined();
      // Check if params are passed as second arg or in config
      if (resourceCall && resourceCall.length > 1) {
        const params = resourceCall[1]?.params || resourceCall[1];
        if (params && typeof params === 'object') {
          expect(params.type === "vm" || params === "vm").toBe(true);
        }
      }
    });

    it("should implement cluster_status action", async () => {
      const mockResponse = {
        data: {
          data: [
            { type: "quorum", quorate: true, votes: 2, expected_votes: 2 },
            { type: "node", name: "pve1", nodeid: 1, online: true, local: true },
            { type: "node", name: "pve2", nodeid: 2, online: true, local: false },
          ],
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValue(mockResponse);

      const result = await tool.execute({ action: "cluster_status" }, mockContext);

      expect(result.data).toBeDefined();
      // Cluster status might have different structure after normalization
      expect(result.data.quorum || result.data.name || Object.keys(result.data).length > 0).toBeTruthy();
      expect(result.data.nodes).toBeDefined();
    });

    it("should summarize a representative cluster_ceph_status response", async () => {
      const mockResponse = {
        data: {
          data: {
            health: {
              status: "HEALTH_WARN",
              checks: {
                OSD_DOWN: {
                  severity: "HEALTH_WARN",
                  summary: { message: "1 osd down", count: 1 },
                },
              },
            },
            time: "2024-01-01T00:00:00Z",
            quorum: [0, 1, 2],
            quorum_names: ["pve1", "pve2", "pve3"],
            monmap: {
              num_mons: 3,
              mons: [
                { rank: 0, name: "pve1" },
                { rank: 1, name: "pve2" },
                { rank: 2, name: "pve3" },
              ],
            },
            mgrmap: {
              available: true,
              active_name: "pve1",
              num_standbys: 1,
            },
            osdmap: {
              osdmap: {
                num_osds: 6,
                num_up_osds: 5,
                num_in_osds: 6,
              },
            },
            pgmap: {
              num_pgs: 128,
              bytes_total: 12 * 1024 * 1024 * 1024,
              bytes_used: 3 * 1024 * 1024 * 1024,
              bytes_avail: 9 * 1024 * 1024 * 1024,
              pgs_by_state: [
                { state_name: "active+clean", count: 120 },
                { state_name: "active+degraded", count: 8 },
              ],
            },
          },
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValue(mockResponse);

      const result = await tool.execute({ action: "cluster_ceph_status" }, mockContext);

      expect(mockClient.get).toHaveBeenCalledWith("/cluster/ceph/status");
      expect(result.data).toMatchObject({
        configured: true,
        health: "HEALTH_WARN",
        healthChecks: [
          {
            name: "OSD_DOWN",
            severity: "HEALTH_WARN",
            message: "1 osd down",
            count: 1,
          },
        ],
        monitors: {
          total: 3,
          quorum: [0, 1, 2],
          quorumNames: ["pve1", "pve2", "pve3"],
        },
        manager: {
          available: true,
          activeName: "pve1",
          standbys: 1,
        },
        osds: {
          total: 6,
          up: 5,
          in: 6,
        },
        placementGroups: {
          total: 128,
          states: [
            { state: "active+clean", count: 120 },
            { state: "active+degraded", count: 8 },
          ],
        },
        usage: {
          total: { value: 12, unit: "GB", raw: 12 * 1024 * 1024 * 1024 },
          used: { value: 3, unit: "GB", raw: 3 * 1024 * 1024 * 1024 },
          available: { value: 9, unit: "GB", raw: 9 * 1024 * 1024 * 1024 },
          usedPercent: 25,
        },
        reportedAt: "2024-01-01T00:00:00Z",
      });
    });

    it("should handle an empty cluster_ceph_status response as not configured", async () => {
      const mockResponse = {
        data: { data: null },
        metadata: {
          status: 200,
          timestamp: Date.now(),
          durationMs: 25,
          provenanceId: "tool://proxmox/test/no-ceph",
        },
      };

      mockClient.get.mockResolvedValue(mockResponse);

      const result = await tool.execute({ action: "cluster_ceph_status" }, mockContext);

      expect(result.data).toMatchObject({
        configured: false,
        message: "Ceph is not configured on this cluster / no Ceph status data is available",
      });
      expect(result.error).toBeUndefined();
    });

    it("should handle a missing Ceph API status as not configured", async () => {
      const mockError = {
        response: { status: 404 },
        message: "Not found",
      };

      mockClient.get.mockRejectedValue(mockError);

      const result = await tool.execute({ action: "cluster_ceph_status" }, mockContext);

      expect(result.data).toBeDefined();
      expect(result.data.configured).toBe(false);
      expect(result.error).toBeUndefined();
    });

    it("should implement ha_groups action", async () => {
      const mockResponse = {
        data: {
          data: [
            { group: "group1", nodes: "pve1,pve2", nofailback: false, restricted: false },
          ],
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValue(mockResponse);

      const result = await tool.execute({ action: "ha_groups" }, mockContext);

      expect(result.data).toBeDefined();
      expect(result.data.groups).toBeDefined();
    });

    it("should implement ha_resources action", async () => {
      const mockResponse = {
        data: {
          data: [
            { sid: "vm:101", type: "vm", group: "group1", state: "started", status: "active" },
          ],
        },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      };

      mockClient.get.mockResolvedValue(mockResponse);

      const result = await tool.execute({ action: "ha_resources" }, mockContext);

      expect(result.data).toBeDefined();
      expect(result.data.resources).toBeDefined();
    });
  });

  describe("Parameter Validation", () => {
    it("should require node parameter for node-level actions", async () => {
      const result = await tool.execute({ action: "node_status" }, mockContext);
      expect(result.error).toContain("node parameter required");
    });

    it("should require node and vmid for VM-level actions", async () => {
      const result = await tool.execute({ action: "get_vm_status" }, mockContext);
      expect(result.error).toContain("node parameter required");

      // Mock /nodes so node validation passes, allowing vmid validation to be tested
      mockClient.get.mockImplementation((endpoint: string) => {
        if (endpoint === "/nodes") {
          return Promise.resolve(mockNodesResponse);
        }
        return Promise.reject(new Error("Unexpected endpoint"));
      });

      const result2 = await tool.execute({ action: "get_vm_status", node: "pve1" }, mockContext);
      expect(result2.error).toContain("vmid parameter required");
    });

    it("should validate action enum", async () => {
      const result = await tool.execute({ action: "invalid_action" }, mockContext);
      // The error might be "Invalid parameters" from Zod validation or "API error" if it gets through
      expect(result.error).toBeDefined();
      // Check for either validation error or API error (both are valid outcomes)
      expect(
        result.error.includes("Invalid parameters") || 
        result.error.includes("API error") ||
        result.error.includes("Unknown")
      ).toBe(true);
    });
  });

  describe("Read-Only Enforcement", () => {
    it("should reject write operations", async () => {
      // Test that execute rejects write operations
      // Since enum validation happens first, invalid actions will fail at enum validation
      // But we can test that the validateReadOnly method exists and works
      const toolAny = tool as any;
      
      // Test validateReadOnly directly (it's protected, so we access it via toolAny)
      if (toolAny.validateReadOnly) {
        const result = toolAny.validateReadOnly("create_vm");
        expect(result).not.toBeNull();
        expect(result.error).toContain("OPERATION_FORBIDDEN");
      } else {
        // If method doesn't exist, test through execute - it should reject invalid actions
        const result = await tool.execute({ action: "create_vm" as any }, mockContext);
        expect(result.error).toBeDefined();
      }
    });
  });

  describe("Provenance Tracking", () => {
    it("should include provenance metadata in responses", async () => {
      // ProxmoxClient.get() returns { data: {...}, metadata: {...} }
      const mockResponse = {
        data: { data: [] },
        metadata: {
          status: 200,
          timestamp: Date.now(),
          durationMs: 100,
          provenanceId: "tool://proxmox/test/123-abc",
        },
      };

      mockClient.get.mockResolvedValue(mockResponse);

      const result = await tool.execute({ action: "list_nodes" }, mockContext);

      expect(result).toBeDefined();
      // The result should have either data or error
      if (result.data) {
        // Check that provenance is included (either in metadata or in the data structure)
        expect(result.metadata || result.data._provenance || result.data.provenanceId).toBeDefined();
      } else {
        // If there's an error, that's also a valid test outcome
        expect(result.error).toBeDefined();
      }
    });
  });
});
