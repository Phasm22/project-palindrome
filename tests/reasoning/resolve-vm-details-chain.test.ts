import { describe, expect, test } from "bun:test";
import { resolveVmDetailsChain } from "../../src/reasoning/chains/compute";
import { BaseTool } from "../../src/tools/BaseTool";
import type { ExecutionContext, ExecutionResult } from "../../src/types";
import type { ToolSession } from "../../src/agent/tool-policy";

const session: ToolSession = { userId: "test-user", aclGroup: "admin" };

/**
 * Deterministic stand-in for proxmox_readonly, backed by a fixed VM list
 * (no live infra calls). Mirrors the real shape of `cluster_resources` /
 * `list_vms` responses that `resolveVmDetailsChain` consumes.
 */
class FakeProxmoxReadonlyTool extends BaseTool {
  constructor(private readonly vms: Array<{ vmid: number; name: string; node: string; type: "qemu" | "lxc" }>) {
    super({
      name: "proxmox_readonly",
      description: "Fake read-only Proxmox tool for tests.",
      categories: ["test"],
      allowedAcls: ["admin"],
      risk: "low",
    });
  }

  async execute(params: Record<string, any>, _context: ExecutionContext): Promise<ExecutionResult> {
    if (params.action === "cluster_resources") {
      return { data: { resources: this.vms } };
    }
    if (params.action === "list_vms") {
      const node = params.node;
      return { data: { node, vms: this.vms.filter((vm) => vm.node.toLowerCase() === String(node).toLowerCase()) } };
    }
    return { error: `Unhandled fake action: ${params.action}` };
  }
}

const GROUND_TRUTH_VMS = [
  { vmid: 100, name: "windowsVM", node: "proxBig", type: "qemu" as const },
  { vmid: 101, name: "pihole", node: "proxBig", type: "lxc" as const },
  { vmid: 102, name: "sentinelZero", node: "YANG", type: "qemu" as const },
  { vmid: 103, name: "sentinel-hunter", node: "YIN", type: "qemu" as const },
];

describe("resolveVmDetailsChain", () => {
  test("resolves an exact-name match", async () => {
    const tools = [new FakeProxmoxReadonlyTool(GROUND_TRUTH_VMS)];
    const result = await resolveVmDetailsChain(tools, session, "pihole");
    expect(result.found).toBe(true);
    expect(result.name).toBe("pihole");
    expect(result.node).toBe("proxBig");
  });

  test("resolves a reasonably specific fuzzy/partial name match", async () => {
    const tools = [new FakeProxmoxReadonlyTool(GROUND_TRUTH_VMS)];
    const result = await resolveVmDetailsChain(tools, session, "sentinel-hunt");
    expect(result.found).toBe(true);
    expect(result.name).toBe("sentinel-hunter");
  });

  test("resolves an exact numeric VMID", async () => {
    const tools = [new FakeProxmoxReadonlyTool(GROUND_TRUTH_VMS)];
    const result = await resolveVmDetailsChain(tools, session, 101);
    expect(result.found).toBe(true);
    expect(result.name).toBe("pihole");
  });

  // H-05 regression: a degenerately short search term (e.g. "n", left over
  // from garbled/adversarial input) must NOT fuzzy-match into an unrelated
  // real VM just because that VM's name happens to contain the character.
  test("H-05: a single-character search term does not fuzzy-match a real VM", async () => {
    const tools = [new FakeProxmoxReadonlyTool(GROUND_TRUTH_VMS)];
    // "windowsVM".toLowerCase() contains "n", "pihole" does not — both are
    // real VMs, and neither should be silently returned as a match for "n".
    const result = await resolveVmDetailsChain(tools, session, "n");
    expect(result.found).toBe(false);
  });

  test("a two-character search term does not fuzzy-match a real VM", async () => {
    const tools = [new FakeProxmoxReadonlyTool(GROUND_TRUTH_VMS)];
    const result = await resolveVmDetailsChain(tools, session, "vm");
    expect(result.found).toBe(false);
  });

  test("not-found result is returned for a name with no match at all", async () => {
    const tools = [new FakeProxmoxReadonlyTool(GROUND_TRUTH_VMS)];
    const result = await resolveVmDetailsChain(tools, session, "totally-unrelated-host");
    expect(result.found).toBe(false);
  });
});
