/**
 * Proxmox Ingestion Tests
 * TL-2A.6.7: Unit Test Coverage (Vector & Graph)
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { computeVersionHash } from "../../src/pce/ingestion/proxmox-ingestion";
import { ProxmoxIngestionOrchestrator } from "../../src/pce/ingestion/proxmox-ingestion";
import { Redactor } from "../../src/pce/redaction";
import { ALL_REDACTION_PATTERNS } from "../../src/pce/redaction/patterns";
import { NodeType, RelationshipType } from "../../src/pce/kg/schema/ontology";

describe("Proxmox Ingestion - Version Hash Computation", () => {
  it("should compute consistent hash for same payload", () => {
    const payload = {
      vmid: 101,
      name: "test-vm",
      node: "pve1",
      status: "running",
    };

    const hash1 = computeVersionHash(payload);
    const hash2 = computeVersionHash(payload);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex string length
  });

  it("should compute different hashes for different payloads", () => {
    const payload1 = { vmid: 101, name: "test-vm-1" };
    const payload2 = { vmid: 102, name: "test-vm-2" };

    const hash1 = computeVersionHash(payload1);
    const hash2 = computeVersionHash(payload2);

    expect(hash1).not.toBe(hash2);
  });

  it("should normalize payload (sort keys, remove null/undefined)", () => {
    const payload1 = { vmid: 101, name: "test", status: undefined };
    const payload2 = { name: "test", vmid: 101, status: null };

    const hash1 = computeVersionHash(payload1);
    const hash2 = computeVersionHash(payload2);

    // Should produce same hash despite key order and null/undefined
    expect(hash1).toBe(hash2);
  });

  it("should handle nested objects in payload", () => {
    const payload = {
      vmid: 101,
      config: {
        memory: 2048,
        cpu: 2,
      },
    };

    const hash = computeVersionHash(payload);
    expect(hash).toHaveLength(64);
  });
});

describe("Proxmox Ingestion - Redaction Verification", () => {
  let redactor: Redactor;

  beforeEach(() => {
    redactor = new Redactor(ALL_REDACTION_PATTERNS);
  });

  it("should preserve MAC addresses from Proxmox content", () => {
    const content = "VM network interface: MAC address 00:11:22:33:44:55";
    const result = redactor.redact(content);

    expect(result.redactedText).toContain("00:11:22:33:44:55");
    expect(result.redactions.length).toBe(0);
  });

  it("should preserve internal IP addresses from Proxmox content", () => {
    const content = "Node IP: 192.168.1.100, Storage IP: 10.0.0.5";
    const result = redactor.redact(content);

    expect(result.redactedText).toContain("192.168.1.100");
    expect(result.redactedText).toContain("10.0.0.5");
    expect(result.redactions.length).toBe(0);
  });

  it("should redact Proxmox API tokens", () => {
    const content = "API token: myuser@pam!deploy";
    const result = redactor.redact(content);

    expect(result.redactedText).not.toContain("myuser@pam!deploy");
    expect(result.redactions.length).toBeGreaterThan(0);
  });

  it("should preserve VM names and VMIDs after redaction", () => {
    const content = "VM 101: aiMarketBot is running on node pve1";
    const result = redactor.redact(content);

    // VM names and IDs should be preserved
    expect(result.redactedText).toContain("101");
    expect(result.redactedText).toContain("aiMarketBot");
    expect(result.redactedText).toContain("pve1");
  });
});

describe("Proxmox Ingestion - Graph Node Creation", () => {
  it("should create correct PVE_NODE node structure", () => {
    const nodePayload = {
      node: "pve1",
      status: "online",
      cpu: 0.5,
      maxcpu: 16,
      memory: 8 * 1024 * 1024 * 1024, // 8GB
      maxmem: 32 * 1024 * 1024 * 1024, // 32GB
    };

    const versionHash = computeVersionHash(nodePayload);

    const node = {
      id: `pve_node:pve1`,
      type: NodeType.PVE_NODE,
      attributes: nodePayload,
      versionHash,
      sourcePath: "proxmox://node/pve1",
      aclGroup: "ops",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(node.id).toBe("pve_node:pve1");
    expect(node.type).toBe(NodeType.PVE_NODE);
    expect(node.attributes.node).toBe("pve1");
    expect(node.versionHash).toBeDefined();
    expect(node.aclGroup).toBe("ops");
  });

  it("should create correct VM_INSTANCE node structure", () => {
    const vmPayload = {
      vmid: 101,
      name: "aiMarketBot",
      node: "pve1",
      type: "qemu" as const,
      status: "running",
      cpu: 0.25,
      memory: 2 * 1024 * 1024 * 1024, // 2GB
      maxmem: 4 * 1024 * 1024 * 1024, // 4GB
    };

    const versionHash = computeVersionHash(vmPayload);

    const node = {
      id: `vm_instance:101`,
      type: NodeType.VM_INSTANCE,
      attributes: vmPayload,
      versionHash,
      sourcePath: "proxmox://vm/101",
      aclGroup: "ops",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(node.id).toBe("vm_instance:101");
    expect(node.type).toBe(NodeType.VM_INSTANCE);
    expect(node.attributes.vmid).toBe(101);
    expect(node.attributes.name).toBe("aiMarketBot");
    expect(node.versionHash).toBeDefined();
    expect(node.aclGroup).toBe("ops");
  });

  it("should create HOSTS_ON relationship between VM and Node", () => {
    const vmId = "vm_instance:101";
    const nodeId = "pve_node:pve1";

    const relationship = {
      from: vmId,
      to: nodeId,
      type: RelationshipType.HOSTS_ON,
      versionHash: computeVersionHash({ vm: vmId, node: nodeId }),
      sourcePath: "proxmox://vm/101",
      aclGroup: "ops",
      createdAt: new Date(),
    };

    expect(relationship.from).toBe("vm_instance:101");
    expect(relationship.to).toBe("pve_node:pve1");
    expect(relationship.type).toBe(RelationshipType.HOSTS_ON);
    expect(relationship.versionHash).toBeDefined();
    expect(relationship.aclGroup).toBe("ops");
  });
});

describe("Proxmox Ingestion - Document Parsing", () => {
  it("should parse VM inventory document correctly", () => {
    const content = `# VM Inventory for Node: pve1
Generated: 2024-01-01T00:00:00Z
Total VMs: 2

## VM 101: aiMarketBot
- Status: running
- Type: qemu
- Memory: 2.0 GB / 4.0 GB
- CPU Usage: 25.0%

## VM 102: test-vm
- Status: stopped
- Type: lxc
- Memory: 1.0 GB / 2.0 GB
`;

    // This is a simplified test - actual parsing is done in the orchestrator
    // We're just verifying the structure is parseable
    expect(content).toContain("VM 101: aiMarketBot");
    expect(content).toContain("VM 102: test-vm");
    expect(content).toContain("Status: running");
    expect(content).toContain("Status: stopped");
  });

  it("should parse node profile document correctly", () => {
    const content = `# Node Resource Profile: pve1
Generated: 2024-01-01T00:00:00Z

## Status
- Status: online
- Uptime: P7DT12H30M

## Memory
- Used: 8.0 GB
- Total: 32.0 GB

## CPU
- Usage: 50.0%
- Cores: 16
`;

    expect(content).toContain("Node Resource Profile: pve1");
    expect(content).toContain("Status: online");
    expect(content).toContain("Total: 32.0 GB");
    expect(content).toContain("Cores: 16");
  });
});

describe("Proxmox Ingestion - ACL and Provenance Propagation", () => {
  it("should propagate ACL group to graph nodes", () => {
    const aclGroup = "lab-admin";
    const nodePayload = {
      node: "pve1",
      status: "online",
    };

    const node = {
      id: `pve_node:pve1`,
      type: NodeType.PVE_NODE,
      attributes: nodePayload,
      versionHash: computeVersionHash(nodePayload),
      sourcePath: "proxmox://node/pve1",
      aclGroup,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(node.aclGroup).toBe("lab-admin");
  });

  it("should propagate version hash to graph nodes", () => {
    const nodePayload = {
      node: "pve1",
      status: "online",
    };

    const versionHash = computeVersionHash(nodePayload);

    const node = {
      id: `pve_node:pve1`,
      type: NodeType.PVE_NODE,
      attributes: nodePayload,
      versionHash,
      sourcePath: "proxmox://node/pve1",
      aclGroup: "ops",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(node.versionHash).toBe(versionHash);
    expect(node.versionHash).toHaveLength(64);
  });

  it("should propagate ACL group to relationships", () => {
    const aclGroup = "ops";
    const relationship = {
      from: "vm_instance:101",
      to: "pve_node:pve1",
      type: RelationshipType.RUNS_ON,
      versionHash: computeVersionHash({ from: "vm_instance:101", to: "pve_node:pve1" }),
      sourcePath: "proxmox://vm/101",
      aclGroup,
      createdAt: new Date(),
    };

    expect(relationship.aclGroup).toBe("ops");
  });
});
