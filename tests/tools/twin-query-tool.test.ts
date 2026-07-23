import { describe, expect, test } from "bun:test";
import { TwinQueryTool } from "../../src/tools/TwinQueryTool";
import { TwinQueryService } from "../../src/twin/api/twin-query-service";
import type { ExecutionContext } from "../../src/types/execution";

function makeContext(): ExecutionContext {
  return { toolName: "twin_query", startedAt: Date.now() };
}

/** Minimal fake TwinQueryService: only the methods TwinQueryTool actually calls. */
function fakeService(overrides: Partial<TwinQueryService> = {}): TwinQueryService {
  const base = {
    findVmByName: async () => [],
    exposureMap: async (vmId?: string) => ({ vmId, calledWith: vmId }) as any,
    vmExposure: async (vmId: string) => ({ vmId, calledWith: vmId }) as any,
    rulesByPort: async () => [],
  };
  return { ...base, ...overrides } as unknown as TwinQueryService;
}

describe("TwinQueryTool vmId resolution (A-TQ-21/23)", () => {
  test("firewall_exposure_map resolves a bare VM display name to its canonical id before querying", async () => {
    let receivedVmId: string | undefined;
    const service = fakeService({
      findVmByName: (async (name: string) => {
        expect(name).toBe("windowsVM");
        return [{ id: "compute-vm:proxbig:100", name: "windowsVM" }];
      }) as any,
      exposureMap: (async (vmId?: string) => {
        receivedVmId = vmId;
        return [];
      }) as any,
    });
    const tool = new TwinQueryTool(service);
    const result = await tool.execute(
      { operation: "firewall_exposure_map", params: { vmId: "windowsVM" } },
      makeContext()
    );
    expect(result.error).toBeUndefined();
    expect(receivedVmId).toBe("compute-vm:proxbig:100");
  });

  test("exposure_vm_analysis resolves a bare display name (e.g. 'opnsense') to its canonical id", async () => {
    let receivedVmId: string | undefined;
    const service = fakeService({
      findVmByName: (async (name: string) => {
        expect(name).toBe("opnsense");
        return [{ id: "compute-vm:proxbig:101", name: "opnsense" }];
      }) as any,
      vmExposure: (async (vmId: string) => {
        receivedVmId = vmId;
        return { vmId, vmName: "opnsense", interfaces: [], exposureLevel: "none" } as any;
      }) as any,
    });
    const tool = new TwinQueryTool(service);
    const result = await tool.execute(
      { operation: "exposure_vm_analysis", params: { vmId: "opnsense" } },
      makeContext()
    );
    expect(result.error).toBeUndefined();
    expect(receivedVmId).toBe("compute-vm:proxbig:101");
  });

  test("already-canonical vmId is passed through unchanged without a name lookup", async () => {
    let lookupCalled = false;
    let receivedVmId: string | undefined;
    const service = fakeService({
      findVmByName: (async () => {
        lookupCalled = true;
        return [];
      }) as any,
      vmExposure: (async (vmId: string) => {
        receivedVmId = vmId;
        return { vmId, vmName: "x", interfaces: [], exposureLevel: "none" } as any;
      }) as any,
    });
    const tool = new TwinQueryTool(service);
    await tool.execute(
      { operation: "exposure_vm_analysis", params: { vmId: "compute-vm:proxbig:100" } },
      makeContext()
    );
    expect(lookupCalled).toBe(false);
    expect(receivedVmId).toBe("compute-vm:proxbig:100");
  });

  test("falls back to the raw value when no VM matches the display name", async () => {
    let receivedVmId: string | undefined;
    const service = fakeService({
      findVmByName: (async () => []) as any,
      vmExposure: (async (vmId: string) => {
        receivedVmId = vmId;
        return { vmId, vmName: vmId, interfaces: [], exposureLevel: "none" } as any;
      }) as any,
    });
    const tool = new TwinQueryTool(service);
    await tool.execute(
      { operation: "exposure_vm_analysis", params: { vmId: "totallyUnknownVm" } },
      makeContext()
    );
    expect(receivedVmId).toBe("totallyUnknownVm");
  });
});

describe("TwinQueryTool firewall_rules_by_port (C-03)", () => {
  test("requires a port param", async () => {
    const tool = new TwinQueryTool(fakeService());
    const result = await tool.execute({ operation: "firewall_rules_by_port", params: {} }, makeContext());
    expect(result.error).toContain("port is required");
  });

  test("passes the port through to the service and returns its rows", async () => {
    const service = fakeService({
      rulesByPort: (async (port: string) => {
        expect(port).toBe("8006");
        return [{ ruleId: "fw-rule:x", action: "pass", destinationPort: "8006" }];
      }) as any,
    });
    const tool = new TwinQueryTool(service);
    const result = await tool.execute(
      { operation: "firewall_rules_by_port", params: { port: 8006 } },
      makeContext()
    );
    expect(result.error).toBeUndefined();
    expect((result.data as any)?.kind).toBe("firewall_rule_list_by_port");
    expect((result.data as any)?.data).toHaveLength(1);
  });
});
