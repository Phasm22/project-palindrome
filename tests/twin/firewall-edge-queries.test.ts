import { describe, expect, test } from "bun:test";
import { Neo4jGraphStore } from "../../src/pce/kg/indexation/neo4j-client";
import { TwinQueryService } from "../../src/twin/api/twin-query-service";

type Row = Record<string, unknown>;

function makeRecord(row: Row) {
  return {
    get: (key: string) => row[key],
  };
}

class FakeGraphStore extends Neo4jGraphStore {
  query = "";

  constructor(private readonly rows: Row[]) {
    super();
  }

  override async connect(): Promise<void> {}
  override async close(): Promise<void> {}
  override getDriver(): any {
    return {
      session: () => ({
        run: async (query: string) => {
          this.query = query;
          return {
            records: this.rows.map(makeRecord),
          };
        },
        close: async () => {},
      }),
    };
  }
}

describe("TwinQueryService firewall edge queries", () => {
  test("internetExposedVms keeps the ALLOWS traversal optional and can return an exposed VM", async () => {
    const graphStore = new FakeGraphStore([
      {
        vmId: "compute-vm:yin:200",
        vmName: "sentinelZero",
        nodeName: "yin",
        subnet: "172.16.0.198/22",
        exposureRules: 1,
      },
    ]);
    const service = new TwinQueryService(
      graphStore as unknown as Neo4jGraphStore
    );

    const result = await service.internetExposedVms();

    expect(graphStore.query).toContain(
      "OPTIONAL MATCH (allowRule:TwinEntity {type: $ruleType})-[:ALLOWS]->(subnet)"
    );
    expect(graphStore.query).not.toMatch(
      /^\s*MATCH \(allowRule:TwinEntity \{type: \$ruleType\}\)-\[:ALLOWS\]->\(subnet\)/m
    );
    expect(result).toEqual([
      {
        vmId: "compute-vm:yin:200",
        vmName: "sentinelZero",
        nodeName: "yin",
        subnet: "172.16.0.198/22",
        exposureRules: 1,
      },
    ]);
  });

  test("vmsExposedToSubnet reports nonzero allow and block counts from materialized edges", async () => {
    const graphStore = new FakeGraphStore([
      {
        vmId: "compute-vm:yin:200",
        vmName: "sentinelZero",
        nodeName: "yin",
        subnet: "172.16.0.198/22",
        allowRules: 2,
        blockRules: 1,
      },
    ]);
    const service = new TwinQueryService(
      graphStore as unknown as Neo4jGraphStore
    );

    const result = await service.vmsExposedToSubnet("172.16.0.0/22");

    expect(graphStore.query).toContain(
      "OPTIONAL MATCH (allowRule:TwinEntity {type: $ruleType})-[:ALLOWS]->(subnet)"
    );
    expect(result[0]?.allowRules).toBe(2);
    expect(result[0]?.blockRules).toBe(1);
  });
});
