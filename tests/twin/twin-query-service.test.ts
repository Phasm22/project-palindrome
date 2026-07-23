import { describe, expect, test } from "bun:test";
import { TwinQueryService } from "../../src/twin/api/twin-query-service";
import { Neo4jGraphStore } from "../../src/pce/kg/indexation/neo4j-client";

type Row = Record<string, unknown>;
type Dispatcher = (query: string, params: Record<string, unknown>) => Row[];

function makeRecord(row: Row) {
  return {
    get: (key: string) => row[key],
  };
}

/**
 * A fake Neo4jGraphStore that never touches live infra. Routes each `session.run`
 * call to canned rows based on the query's own bound params (each query in
 * twin-query-service.ts passes a distinctive params shape), so tests can assert
 * on the service's pure JS-side logic (CIDR filtering, alias/port parsing, etc.)
 * without a live Neo4j instance.
 */
class FakeGraphStore extends Neo4jGraphStore {
  constructor(private readonly dispatch: Dispatcher) {
    super();
  }
  override async connect(): Promise<void> {}
  override async close(): Promise<void> {}
  override getDriver(): any {
    const dispatch = this.dispatch;
    return {
      session: () => ({
        run: async (query: string, params: Record<string, unknown> = {}) => {
          const rows = dispatch(query, params);
          return { records: rows.map(makeRecord) };
        },
        close: async () => {},
      }),
    };
  }
}

function serviceWith(dispatch: Dispatcher): TwinQueryService {
  return new TwinQueryService(new FakeGraphStore(dispatch) as unknown as Neo4jGraphStore);
}

describe("TwinQueryService.vmsBySubnet", () => {
  test("matches VMs whose host-address subnet falls inside the requested canonical CIDR (A-TQ-10)", async () => {
    const service = serviceWith((_query, params) => {
      if (params.ifaceType && params.subnetType && params.vmType) {
        return [
          { vmId: "compute-vm:proxbig:100", vmName: "windowsVM", subnet: "172.16.0.100/22", nodeName: "proxBig" },
          { vmId: "compute-vm:yin:200", vmName: "sentinelZero", subnet: "172.16.0.198/22", nodeName: "yin" },
          { vmId: "compute-vm:yang:103", vmName: "PvVPN-Home", subnet: "192.168.71.40/22", nodeName: "YANG" },
        ];
      }
      return [];
    });

    const result = await service.vmsBySubnet("172.16.0.0/22");
    expect(result.map((r) => r.vmName).sort()).toEqual(["sentinelZero", "windowsVM"]);
  });

  test("returns no matches when nothing overlaps the requested subnet", async () => {
    const service = serviceWith(() => [
      { vmId: "compute-vm:yang:103", vmName: "PvVPN-Home", subnet: "192.168.71.40/22", nodeName: "YANG" },
    ]);
    const result = await service.vmsBySubnet("10.10.31.0/24");
    expect(result).toEqual([]);
  });
});

describe("TwinQueryService.rulesBlockingSubnet", () => {
  test("matches a rule via its literal CIDR source, without any BLOCKS relationship (A-TQ-16)", async () => {
    const service = serviceWith((_query, params) => {
      if (params.ruleType === "firewall_rule" && !("port" in params)) {
        return [
          {
            ruleId: "fw-rule:vtnet1:block:in:192.168.68.0_22",
            action: "block",
            direction: "in",
            protocol: null,
            source: "192.168.68.0/22",
            destination: "any",
          },
          {
            ruleId: "fw-rule:default:block:in:sshlockout",
            action: "block",
            direction: "in",
            protocol: "tcp",
            source: "<sshlockout>",
            destination: "(self)",
          },
        ];
      }
      if (params.aliasType === "firewall_alias") {
        return [];
      }
      return [];
    });

    const result = await service.rulesBlockingSubnet("192.168.68.0/22");
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe("fw-rule:vtnet1:block:in:192.168.68.0_22");
    expect(result[0]?.subnetCidr).toBe("192.168.68.0/22");
  });

  test("resolves an alias-based source via the alias CIDR lookup", async () => {
    const service = serviceWith((_query, params) => {
      if (params.ruleType === "firewall_rule" && !("port" in params)) {
        return [
          {
            ruleId: "fw-rule:vtnet0:block:in:wg-vip",
            action: "block",
            direction: "in",
            protocol: null,
            source: "<WG_VIP>",
            destination: "any",
          },
        ];
      }
      if (params.aliasType === "firewall_alias") {
        return [{ id: "firewall-alias:wg_vip", name: "WG_VIP", type: "network", dataJson: JSON.stringify({ cidrs: ["10.16.0.0/29"], entries: ["10.16.0.0/29"] }) }];
      }
      return [];
    });

    const result = await service.rulesBlockingSubnet("10.16.0.0/29");
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe("fw-rule:vtnet0:block:in:wg-vip");
  });

  test("returns no matches when no rule's source/destination overlaps the subnet", async () => {
    const service = serviceWith((_query, params) => {
      if (params.ruleType === "firewall_rule" && !("port" in params)) {
        return [
          { ruleId: "r1", action: "block", direction: "in", source: "10.10.31.0/24", destination: "any" },
        ];
      }
      return [];
    });
    const result = await service.rulesBlockingSubnet("192.168.68.0/22");
    expect(result).toEqual([]);
  });
});

describe("TwinQueryService.reachableFromInterfaceChain", () => {
  test("treats an unrestricted (any-destination) pass rule as reaching every VM (A-TQ-19)", async () => {
    const service = serviceWith((_query, params) => {
      if (params.ruleType === "firewall_rule" && "chain" in params) {
        return [
          { ruleId: "fw-rule:wireguard:pass:out:wg-vip:any", destination: "any" },
          { ruleId: "fw-rule:wireguard:pass:in:wg-vip:vtnet0-network", destination: "(vtnet0:network)" },
        ];
      }
      if (params.aliasType === "firewall_alias") {
        return [];
      }
      if (params.ifaceType && params.subnetType && params.vmType) {
        return [
          { vmId: "compute-vm:proxbig:100", vmName: "windowsVM", subnet: "172.16.0.100/22", subnetId: "network-subnet:172.16.0.100/22" },
          { vmId: "compute-vm:yin:200", vmName: "sentinelZero", subnet: "172.16.0.198/22", subnetId: "network-subnet:172.16.0.198/22" },
        ];
      }
      return [];
    });

    const result = await service.reachableFromInterfaceChain("chain:wireguard");
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.allowedBy.includes("fw-rule:wireguard:pass:out:wg-vip:any"))).toBe(true);
    // The (vtnet0:network) macro isn't resolvable from twin interface names and
    // is intentionally left unmatched rather than guessed at.
    expect(result.every((r) => !r.allowedBy.includes("fw-rule:wireguard:pass:in:wg-vip:vtnet0-network"))).toBe(true);
  });

  test("returns empty when the chain has no pass rules with a resolvable destination", async () => {
    const service = serviceWith((_query, params) => {
      if (params.ruleType === "firewall_rule" && "chain" in params) {
        return [{ ruleId: "fw-rule:x:pass:in:wg-vip:vtnet1-network", destination: "(vtnet1:network)" }];
      }
      if (params.aliasType === "firewall_alias") return [];
      return [];
    });
    const result = await service.reachableFromInterfaceChain("chain:wireguard");
    expect(result).toEqual([]);
  });

  test("scopes a CIDR-restricted pass rule to only the overlapping subnet", async () => {
    const service = serviceWith((_query, params) => {
      if (params.ruleType === "firewall_rule" && "chain" in params) {
        return [{ ruleId: "fw-rule:x:pass:in:172.16", destination: "172.16.0.0/22" }];
      }
      if (params.aliasType === "firewall_alias") return [];
      if (params.ifaceType && params.subnetType && params.vmType) {
        return [
          { vmId: "compute-vm:proxbig:100", vmName: "windowsVM", subnet: "172.16.0.100/22", subnetId: "s1" },
          { vmId: "compute-vm:yang:103", vmName: "PvVPN-Home", subnet: "192.168.71.40/22", subnetId: "s2" },
        ];
      }
      return [];
    });
    const result = await service.reachableFromInterfaceChain("chain:vtnet0");
    expect(result.map((r) => r.vmName)).toEqual(["windowsVM"]);
  });
});

describe("TwinQueryService.vmsExposedToSubnet", () => {
  test("does not match a same-mask (/22) subnet on a genuinely different physical network (A-TQ-22)", async () => {
    const service = serviceWith((_query, params) => {
      if (params.vmType && params.nodeType && params.ifaceType) {
        return [
          // Same /22 mask, same physical HomeNet block (192.168.68.0-71.255) — should match.
          { vmId: "compute-vm:proxbig:100", vmName: "windowsVM", nodeName: "proxBig", subnet: "192.168.68.78/22", allowRules: 0, blockRules: 0 },
          // Same /22 mask, but a genuinely different physical network (LabNet) — must NOT match
          // just because the mask suffix happens to match too.
          { vmId: "compute-vm:yin:200", vmName: "sentinelZero", nodeName: "yin", subnet: "172.16.0.198/22", allowRules: 0, blockRules: 0 },
        ];
      }
      return [];
    });

    const result = await service.vmsExposedToSubnet("192.168.68.0/22");
    expect(result.map((r) => r.vmName)).toEqual(["windowsVM"]);
  });
});

describe("TwinQueryService.rulesByPort", () => {
  test("matches a rule via its parsed destinationPort field (C-03)", async () => {
    const service = serviceWith((_query, params) => {
      if (params.ruleType === "firewall_rule" && params.port === "8006") {
        return [
          {
            ruleId: "fw-rule:vtnet0:pass:out:8006",
            dataJson: JSON.stringify({
              action: "pass",
              direction: "out",
              protocol: "tcp",
              source: "(vtnet0:network)",
              destination: "(vtnet1:network)",
              sourcePort: null,
              destinationPort: "8006",
              chain: "chain:vtnet0",
            }),
          },
        ];
      }
      return [];
    });

    const result = await service.rulesByPort("8006");
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe("fw-rule:vtnet0:pass:out:8006");
    expect(result[0]?.destinationPort).toBe("8006");
  });

  test("rejects a CONTAINS pre-filter false-positive that doesn't actually match the port field", async () => {
    const service = serviceWith((_query, params) => {
      if (params.ruleType === "firewall_rule" && params.port === "80") {
        return [
          {
            // Contains the substring "80" (in the rule id) but its real ports are unrelated.
            ruleId: "fw-rule:vtnet0:pass:out:8006-and-more-80x",
            dataJson: JSON.stringify({
              action: "pass",
              sourcePort: null,
              destinationPort: "8006",
            }),
          },
        ];
      }
      return [];
    });

    const result = await service.rulesByPort("80");
    expect(result).toEqual([]);
  });

  test("is case-insensitive for named ports", async () => {
    const service = serviceWith((_query, params) => {
      if (params.ruleType === "firewall_rule" && params.port === "ssh") {
        return [
          {
            ruleId: "fw-rule:vtnet0:pass:in:ssh",
            dataJson: JSON.stringify({ action: "pass", destinationPort: "SSH" }),
          },
        ];
      }
      return [];
    });
    const result = await service.rulesByPort("SSH");
    expect(result).toHaveLength(1);
  });
});
