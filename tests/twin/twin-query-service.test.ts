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
  test("matches a rule through its materialized BLOCKS edge", async () => {
    const service = serviceWith((query) => {
      if (query.includes("-[:BLOCKS]->")) {
        return [
          {
            ruleId: "fw-rule:vtnet1:block:in:192.168.68.0_22",
            action: "block",
            direction: "in",
            protocol: null,
            subnetId: "network-subnet:192.168.68.0/22",
            subnetCidr: "192.168.68.0/22",
          },
        ];
      }
      return [];
    });

    const result = await service.rulesBlockingSubnet("192.168.68.0/22");
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe("fw-rule:vtnet1:block:in:192.168.68.0_22");
    expect(result[0]?.subnetCidr).toBe("192.168.68.0/22");
  });

  test("returns alias-derived rules through their ingested BLOCKS edges", async () => {
    const service = serviceWith((query) => {
      if (query.includes("-[:BLOCKS]->")) {
        return [
          {
            ruleId: "fw-rule:vtnet0:block:in:wg-vip",
            action: "block",
            direction: "in",
            protocol: null,
            subnetId: "network-subnet:10.16.0.0/29",
            subnetCidr: "10.16.0.0/29",
          },
        ];
      }
      return [];
    });

    const result = await service.rulesBlockingSubnet("10.16.0.0/29");
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe("fw-rule:vtnet0:block:in:wg-vip");
  });

  test("returns no matches when the subnet has no BLOCKS edge", async () => {
    const service = serviceWith(() => []);
    const result = await service.rulesBlockingSubnet("192.168.68.0/22");
    expect(result).toEqual([]);
  });
});

describe("TwinQueryService.reachableFromInterfaceChain", () => {
  test("returns every VM targeted by a chain's materialized ALLOWS edges", async () => {
    const service = serviceWith((query) => {
      if (query.includes("-[:ALLOWS]->")) {
        return [
          {
            vmId: "compute-vm:proxbig:100",
            vmName: "windowsVM",
            subnet: "172.16.0.100/22",
            subnetId: "network-subnet:172.16.0.100/22",
            allowedBy: ["fw-rule:wireguard:pass:out:wg-vip:any"],
            blockedBy: [],
          },
          {
            vmId: "compute-vm:yin:200",
            vmName: "sentinelZero",
            subnet: "172.16.0.198/22",
            subnetId: "network-subnet:172.16.0.198/22",
            allowedBy: ["fw-rule:wireguard:pass:out:wg-vip:any"],
            blockedBy: [],
          },
        ];
      }
      return [];
    });

    const result = await service.reachableFromInterfaceChain("chain:wireguard");
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.allowedBy.includes("fw-rule:wireguard:pass:out:wg-vip:any"))).toBe(true);
  });

  test("returns empty when the chain has no ALLOWS edges", async () => {
    const service = serviceWith(() => []);
    const result = await service.reachableFromInterfaceChain("chain:wireguard");
    expect(result).toEqual([]);
  });

  test("returns only VMs attached to subnets targeted by the chain edge", async () => {
    const service = serviceWith((query) => {
      if (query.includes("-[:ALLOWS]->")) {
        return [
          {
            vmId: "compute-vm:proxbig:100",
            vmName: "windowsVM",
            subnet: "172.16.0.100/22",
            subnetId: "s1",
            allowedBy: ["fw-rule:x:pass:in:172.16"],
            blockedBy: [],
          },
        ];
      }
      return [];
    });
    const result = await service.reachableFromInterfaceChain("chain:vtnet0");
    expect(result.map((r) => r.vmName)).toEqual(["windowsVM"]);
  });
});

describe("TwinQueryService.reachableFromSubnet", () => {
  test("scopes by rule source and returns VMs on destination subnets", async () => {
    const service = serviceWith((query) => {
      if (query.includes("allowRules") && query.includes("destinationSubnetCidr")) {
        return [
          {
            vmId: "compute-vm:yang:101",
            vmName: "lab-vm",
            subnet: "192.168.1.10/24",
            subnetId: "network-subnet:192.168.1.0/24",
            destinationSubnetCidr: "192.168.1.0/24",
            allowRules: [
              {
                id: "fw-rule:pass:10.0.0.0_24:192.168.1.0_24",
                source: "10.0.0.0/24",
                destination: "192.168.1.0/24",
              },
            ],
            blockRules: [],
          },
        ];
      }
      return [];
    });

    const result = await service.reachableFromSubnet("10.0.0.0/24");
    expect(result.map((r) => r.vmName)).toEqual(["lab-vm"]);
    expect(result[0]?.allowedBy).toEqual(["fw-rule:pass:10.0.0.0_24:192.168.1.0_24"]);
  });

  test("does not scope from destination-only edges into the requested subnet", async () => {
    const service = serviceWith((query) => {
      if (query.includes("allowRules") && query.includes("destinationSubnetCidr")) {
        return [
          {
            vmId: "compute-vm:yang:101",
            vmName: "lab-vm",
            subnet: "10.0.0.5/24",
            subnetId: "network-subnet:10.0.0.0/24",
            destinationSubnetCidr: "10.0.0.0/24",
            allowRules: [
              {
                id: "fw-rule:pass:192.168.1.0_24:10.0.0.0_24",
                source: "192.168.1.0/24",
                destination: "10.0.0.0/24",
              },
            ],
            blockRules: [],
          },
        ];
      }
      return [];
    });

    const result = await service.reachableFromSubnet("10.0.0.0/24");
    expect(result).toEqual([]);
  });

  test("treats source any as applicable and drops same-subnet self-hits without explicit dest", async () => {
    const service = serviceWith((query) => {
      if (query.includes("allowRules") && query.includes("destinationSubnetCidr")) {
        return [
          {
            vmId: "compute-vm:yang:200",
            vmName: "cross-vm",
            subnet: "192.168.1.10/24",
            subnetId: "network-subnet:192.168.1.0/24",
            destinationSubnetCidr: "192.168.1.0/24",
            allowRules: [
              {
                id: "fw-rule:pass:any:192.168.1.0_24",
                source: "any",
                destination: "192.168.1.0/24",
              },
            ],
            blockRules: [],
          },
          {
            vmId: "compute-vm:proxbig:10",
            vmName: "self-hit",
            subnet: "10.0.0.8/24",
            subnetId: "network-subnet:10.0.0.0/24",
            destinationSubnetCidr: "10.0.0.0/24",
            allowRules: [
              {
                id: "fw-rule:pass:10.0.0.0_24:any",
                source: "10.0.0.0/24",
                destination: "any",
              },
            ],
            blockRules: [],
          },
        ];
      }
      return [];
    });

    const result = await service.reachableFromSubnet("10.0.0.0/24");
    expect(result.map((r) => r.vmName)).toEqual(["cross-vm"]);
  });

  test("unresolved non-CIDR allow source does not grant permission", async () => {
    const service = serviceWith((query) => {
      if (query.includes("allowRules") && query.includes("destinationSubnetCidr")) {
        return [
          {
            vmId: "compute-vm:yang:101",
            vmName: "lab-vm",
            subnet: "192.168.1.10/24",
            subnetId: "network-subnet:192.168.1.0/24",
            destinationSubnetCidr: "192.168.1.0/24",
            allowRules: [
              {
                id: "fw-rule:pass:alias:192.168.1.0_24",
                source: "sshlockout",
                destination: "192.168.1.0/24",
              },
            ],
            blockRules: [],
          },
        ];
      }
      return [];
    });

    const result = await service.reachableFromSubnet("10.0.0.0/24");
    expect(result).toEqual([]);
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
