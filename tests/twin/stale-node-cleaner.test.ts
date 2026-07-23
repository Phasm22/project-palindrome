import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Neo4jGraphStore } from "../../src/pce/kg/indexation/neo4j-client";

const CLUSTER_CONFIG = {
  url: "https://yin.prox:8006",
  tokenId: "cluster-token",
  tokenSecret: "cluster-secret",
  verifySsl: false,
  label: "cluster",
  credentialSource: "test",
};
const PROXBIG_CONFIG = {
  url: "https://proxbig.prox:8006",
  tokenId: "proxbig-token",
  tokenSecret: "proxbig-secret",
  verifySsl: false,
  label: "proxbig",
  credentialSource: "test",
};

vi.mock("../../src/tools/proxmox/config", () => ({
  getProxmoxEndpointConfigs: () => [CLUSTER_CONFIG, PROXBIG_CONFIG],
}));

// proxBig's endpoint fails this run; the cluster (yin/yang) endpoint succeeds
// and reports only sentinelZero (vmid 200) — windowsVM (vmid 100, on proxBig)
// is absent everywhere, but only because its own endpoint never answered.
let proxbigShouldFail = true;

vi.mock("../../src/tools/proxmox/client", () => ({
  ProxmoxClient: vi.fn().mockImplementation((config: any) => ({
    get: vi.fn(async () => {
      if (config.url.includes("proxbig")) {
        if (proxbigShouldFail) {
          throw new Error("simulated proxBig outage");
        }
        return { data: { data: [] } }; // proxBig reachable, genuinely has no VMs
      }
      return {
        data: {
          data: [{ vmid: 200, node: "yin", type: "qemu", name: "sentinelZero" }],
        },
      };
    }),
  })),
}));

import { StaleNodeCleaner } from "../../src/twin/cleanup/stale-node-cleaner";

function makeFakeGraphStore(twinVms: Array<{ id: string; name: string; nodeName: string }>) {
  const deleteCalls: string[] = [];
  const session = {
    run: vi.fn(async (query: string, params: any) => {
      if (query.includes("DETACH DELETE vm")) {
        deleteCalls.push(params.id);
        return { records: [] };
      }
      // The twin-VMs-listing query
      return {
        records: twinVms.map((vm) => ({
          get: (key: string) => {
            if (key === "id") return vm.id;
            if (key === "name") return vm.name;
            if (key === "nodeName") return vm.nodeName;
            if (key === "vmKind") return "qemu";
            if (key === "lastSeen") return null;
            return undefined;
          },
        })),
      };
    }),
    close: vi.fn(async () => {}),
  };

  const graphStore = {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    getDriver: () => ({ session: () => session }),
  } as unknown as Neo4jGraphStore;

  return { graphStore, deleteCalls };
}

describe("StaleNodeCleaner.cleanStaleVms — endpoint-attribution fix", () => {
  beforeEach(() => {
    proxbigShouldFail = true;
  });

  it("keeps (does not delete) a VM whose endpoint failed this run", async () => {
    const { graphStore, deleteCalls } = makeFakeGraphStore([
      { id: "compute-vm:proxbig:100", name: "windowsVM", nodeName: "proxBig" },
      { id: "compute-vm:yin:200", name: "sentinelZero", nodeName: "yin" },
    ]);
    const cleaner = new StaleNodeCleaner(graphStore);

    const result = await cleaner.cleanStaleVms();

    expect(deleteCalls).not.toContain("compute-vm:proxbig:100");
    expect(result.details.some((d) => d.includes("Skipped") && d.includes("fetch failures"))).toBe(true);
    // sentinelZero's endpoint (cluster) succeeded and it's really there — not stale.
    expect(deleteCalls).not.toContain("compute-vm:yin:200");
  });

  it("still deletes a genuinely-gone VM once its endpoint is reachable", async () => {
    proxbigShouldFail = false; // proxBig now answers: no VMs there at all
    const { graphStore, deleteCalls } = makeFakeGraphStore([
      { id: "compute-vm:proxbig:100", name: "windowsVM", nodeName: "proxBig" },
    ]);
    const cleaner = new StaleNodeCleaner(graphStore);

    const result = await cleaner.cleanStaleVms();

    expect(deleteCalls).toContain("compute-vm:proxbig:100");
    expect(result.deleted).toBe(1);
  });
});
