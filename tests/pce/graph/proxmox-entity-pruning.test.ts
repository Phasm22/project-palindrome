import { describe, expect, test } from "bun:test";
import {
  pruneStaleProxmoxVmEntities,
  selectStaleProxmoxVmEntityIds,
} from "../../../src/pce/kg/indexation/graph-indexer";

describe("Proxmox RAG entity pruning", () => {
  test("selects only stale VMs from complete node snapshots", () => {
    const staleIds = selectStaleProxmoxVmEntityIds(
      [
        {
          id: "vm_instance:100",
          attributes: JSON.stringify({ node: "yin" }),
          sourcePath: "proxmox://vm/100",
        },
        {
          id: "vm_instance:101",
          attributes: JSON.stringify({ node: "yin" }),
          sourcePath: "proxmox://vm/101",
        },
        {
          id: "vm_instance:200",
          attributes: JSON.stringify({ node: "yang" }),
          sourcePath: "proxmox://vm/200",
        },
        {
          id: "vm_instance:external",
          attributes: JSON.stringify({ node: "yin" }),
          sourcePath: "manual://vm/external",
        },
      ],
      [{ nodeName: "yin", keepIds: ["vm_instance:100"] }]
    );

    expect(staleIds).toEqual(["vm_instance:101"]);
  });

  test("deletes selected stale IDs through mocked graph IO", async () => {
    const calls: Array<{ query: string; params: Record<string, unknown> }> = [];
    let closed = false;
    const session = {
      run: async (query: string, params: Record<string, unknown>) => {
        calls.push({ query, params });
        if (query.includes("RETURN n.id AS id")) {
          const stored = [
            {
              id: "vm_instance:100",
              attributes: JSON.stringify({ node: "yin" }),
              sourcePath: "proxmox://vm/100",
            },
            {
              id: "vm_instance:101",
              attributes: JSON.stringify({ node: "yin" }),
              sourcePath: "proxmox://vm/101",
            },
          ];
          return {
            records: stored.map((entity) => ({
              get: (key: keyof typeof entity) => entity[key],
            })),
          };
        }
        return { records: [] };
      },
      close: async () => {
        closed = true;
      },
    };
    const graphStore = {
      getDriver: () => ({ session: () => session }),
    };

    const deleted = await pruneStaleProxmoxVmEntities(
      graphStore as any,
      [{ nodeName: "yin", keepIds: ["vm_instance:100"] }]
    );

    expect(deleted).toEqual(["vm_instance:101"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.params).toEqual({
      type: "VM_INSTANCE",
      staleIds: ["vm_instance:101"],
    });
    expect(calls[1]?.query).toContain("DETACH DELETE n");
    expect(closed).toBe(true);
  });

  test("an empty successful snapshot prunes every mirrored VM for that node", () => {
    const staleIds = selectStaleProxmoxVmEntityIds(
      [
        {
          id: "vm_instance:100",
          attributes: { node: "yin" },
          sourcePath: "proxmox://vm/100",
        },
      ],
      [{ nodeName: "yin", keepIds: [] }]
    );

    expect(staleIds).toEqual(["vm_instance:100"]);
  });
});
