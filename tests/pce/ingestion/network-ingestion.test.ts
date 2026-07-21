import { describe, it, expect, vi, beforeEach } from "vitest";
import { TwinEntityType } from "../../../src/twin/models/entities";

const proxmoxExecuteMock = vi.fn();
vi.mock("../../../src/tools/proxmox/readonly/proxmox-readonly-tool", () => ({
  ProxmoxReadOnlyTool: vi.fn().mockImplementation(() => ({
    execute: proxmoxExecuteMock,
  })),
}));

vi.mock("../../../src/tools/MCPOpnsenseTool", () => ({
  MCPOpnsenseTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn(async () => ({ data: { interfaces: [] } })),
    close: vi.fn(),
  })),
}));

const parseMock = vi.fn();
vi.mock("../../../src/parsers/network/proxmox-interface-parser", () => ({
  ProxmoxInterfaceParser: vi.fn().mockImplementation(() => ({
    parse: parseMock,
  })),
}));

vi.mock("../../../src/parsers/network/opnsense-interface-parser", () => ({
  OpnsenseInterfaceParser: vi.fn().mockImplementation(() => ({
    parse: vi.fn(async () => ({ entities: [], relationships: [] })),
  })),
}));

const twinUpdaterMocks = {
  initialize: vi.fn(async () => {}),
  upsert: vi.fn(async () => {}),
  pruneEntitiesByTypeAndSource: vi.fn(async () => 0),
  close: vi.fn(async () => {}),
};
vi.mock("../../../src/twin", () => ({
  TwinUpdateService: vi.fn().mockImplementation(() => twinUpdaterMocks),
}));

import { NetworkIngestionOrchestrator } from "../../../src/pce/ingestion/network-ingestion";

function fakeInterfaceEntity(node: string) {
  return {
    id: `network-if:${node}:if0`,
    type: TwinEntityType.NETWORK_INTERFACE,
    displayName: `${node}-if0`,
  };
}

describe("NetworkIngestionOrchestrator — per-node failure isolation", () => {
  beforeEach(() => {
    proxmoxExecuteMock.mockReset();
    parseMock.mockReset();
    twinUpdaterMocks.initialize.mockClear();
    twinUpdaterMocks.upsert.mockClear();
    twinUpdaterMocks.pruneEntitiesByTypeAndSource.mockClear();

    parseMock.mockImplementation(async (input: any) => ({
      entities: input.nodes.map((n: any) => fakeInterfaceEntity(n.node)),
      relationships: [],
    }));
  });

  it("keeps a healthy node's interfaces and skips pruning when a sibling node fails", async () => {
    proxmoxExecuteMock.mockImplementation(async (params: any) => {
      if (params.action === "list_nodes") {
        return { data: { nodes: [{ node: "yin" }, { node: "yang" }] } };
      }
      if (params.action === "node_network_interfaces") {
        if (params.node === "yang") {
          throw new Error("simulated yang timeout");
        }
        return { data: { interfaces: [{ iface: "vmbr0" }] } };
      }
      if (params.action === "list_vms") {
        return { data: { vms: [] } };
      }
      return { data: {} };
    });

    const orchestrator = new NetworkIngestionOrchestrator();
    const result = await orchestrator.ingestNetwork({ includeOpnsense: false });

    expect(result.proxmoxDegraded).toBe(true);

    // yin's interface made it into the upsert despite yang's failure.
    const upsertedEntities = twinUpdaterMocks.upsert.mock.calls[0]?.[0] ?? [];
    expect(upsertedEntities.some((e: any) => e.id === "network-if:yin:if0")).toBe(true);
    expect(upsertedEntities.some((e: any) => e.id === "network-if:yang:if0")).toBe(false);

    // Incomplete snapshot this cycle — must NOT prune the proxmox source,
    // or yang's real (just-unfetched) interfaces would get deleted outright.
    expect(twinUpdaterMocks.pruneEntitiesByTypeAndSource).not.toHaveBeenCalled();
  });

  it("still prunes normally when every node succeeds", async () => {
    proxmoxExecuteMock.mockImplementation(async (params: any) => {
      if (params.action === "list_nodes") {
        return { data: { nodes: [{ node: "yin" }] } };
      }
      if (params.action === "node_network_interfaces") {
        return { data: { interfaces: [{ iface: "vmbr0" }] } };
      }
      if (params.action === "list_vms") {
        return { data: { vms: [] } };
      }
      return { data: {} };
    });

    const orchestrator = new NetworkIngestionOrchestrator();
    const result = await orchestrator.ingestNetwork({ includeOpnsense: false });

    expect(result.proxmoxDegraded).toBe(false);
    expect(twinUpdaterMocks.pruneEntitiesByTypeAndSource).toHaveBeenCalled();
  });
});
