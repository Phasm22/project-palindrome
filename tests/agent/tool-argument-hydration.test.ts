import { describe, expect, test } from "bun:test";
import {
  extractResolvedVmEntity,
  hydrateProxmoxReadArgs,
} from "../../src/agent/handlers/tool-argument-hydration";

describe("Proxmox read argument hydration", () => {
  test("extracts a unique VM identity from a twin name lookup", () => {
    expect(
      extractResolvedVmEntity("twin_query", {
        kind: "vm_list",
        vmName: "homebridge",
        data: [
          {
            id: "compute-vm:yang:100",
            name: "homebridge",
            nodeName: "YANG",
            state: "running",
            vmKind: "lxc",
          },
        ],
      })
    ).toEqual({
      name: "homebridge",
      node: "YANG",
      vmid: 100,
      type: "lxc",
    });
  });

  test("does not resolve an ambiguous VM list", () => {
    expect(
      extractResolvedVmEntity("twin_query", {
        data: [
          { id: "compute-vm:yin:100", nodeName: "yin" },
          { id: "compute-vm:yang:100", nodeName: "YANG" },
        ],
      })
    ).toBeNull();
  });

  test("hydrates VM config parameters without overriding explicit values", () => {
    const resolution = {
      name: "homebridge",
      node: "YANG",
      vmid: 100,
      type: "lxc" as const,
    };

    expect(
      hydrateProxmoxReadArgs(
        "proxmox_readonly",
        { action: "get_vm_config" },
        resolution
      )
    ).toEqual({
      args: {
        action: "get_vm_config",
        node: "YANG",
        vmid: 100,
        type: "lxc",
      },
      hydrated: ["node", "vmid", "type"],
    });

    expect(
      hydrateProxmoxReadArgs(
        "proxmox_readonly",
        { action: "get_vm_config", node: "yin", vmid: 200, type: "qemu" },
        resolution
      )
    ).toEqual({
      args: {
        action: "get_vm_config",
        node: "yin",
        vmid: 200,
        type: "qemu",
      },
      hydrated: [],
    });
  });

  test("hydrates node task filters from the resolved VM", () => {
    expect(
      hydrateProxmoxReadArgs(
        "proxmox_readonly",
        { action: "node_tasks" },
        { node: "YANG", vmid: 100, type: "lxc" }
      )
    ).toEqual({
      args: { action: "node_tasks", node: "YANG", vmid: 100 },
      hydrated: ["node", "vmid"],
    });
  });
});
