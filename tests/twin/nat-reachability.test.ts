import { describe, expect, test } from "bun:test";
import { Neo4jGraphStore } from "../../src/pce/kg/indexation/neo4j-client";
import { TwinQueryService } from "../../src/twin/api/twin-query-service";

type Row = Record<string, unknown>;

function makeRecord(row: Row) {
  return {
    get: (key: string) => row[key],
  };
}

class FixtureGraphStore extends Neo4jGraphStore {
  override async connect(): Promise<void> {}
  override async close(): Promise<void> {}
  override getDriver(): any {
    return {
      session: () => ({
        run: async (query: string) => {
          expect(query).toContain("TRANSLATES_TO");
          expect(query).toContain("ALLOWS");
          expect(query).toContain("BLOCKS");
          const translation = {
            translatedFrom: "network-subnet:203.0.113.10/32",
            metadataJson: JSON.stringify({
              ruleId: "fw-rule:em0:rdr:web",
              ruleType: "rdr",
              sourceMatch: "any",
            }),
          };
          return {
            records: [
              {
                id: "network-if:app:web",
                name: "web",
                type: "network_interface",
                subnet: "192.168.1.10/32",
                subnetId: "network-subnet:192.168.1.10/32",
                sourceSubnetId: "network-subnet:198.51.100.20/24",
                sourceSubnetCidr: "198.51.100.20/24",
                translations: [translation],
                allowRules: [{ id: "fw-rule:em0:pass:web", source: "any" }],
                blockRules: [],
              },
              {
                id: "network-if:admin:ui",
                name: "admin-ui",
                type: "network_interface",
                subnet: "192.168.1.11/32",
                subnetId: "network-subnet:192.168.1.11/32",
                sourceSubnetId: "network-subnet:198.51.100.20/24",
                sourceSubnetCidr: "198.51.100.20/24",
                translations: [
                  {
                    ...translation,
                    translatedFrom: "network-subnet:203.0.113.11/32",
                    metadataJson: JSON.stringify({
                      ruleId: "fw-rule:em0:rdr:admin",
                      ruleType: "rdr",
                      sourceMatch: "any",
                    }),
                  },
                ],
                allowRules: [{ id: "fw-rule:em0:pass:admin", source: "any" }],
                blockRules: [{ id: "fw-rule:em0:block:admin", source: "any" }],
              },
            ].map(makeRecord),
          };
        },
        close: async () => {},
      }),
    };
  }
}

describe("TwinQueryService.reachability NAT verdicts", () => {
  test("reports reachable and blocked rdr targets from graph-edge evidence", async () => {
    const service = new TwinQueryService(new FixtureGraphStore());

    const result = await service.reachability("network-if:client:wan");

    expect(result).toContainEqual({
      id: "network-if:app:web",
      name: "web",
      type: "network_interface",
      viaSubnet: "192.168.1.10/32",
      verdict: "reachable",
      path: "rdr",
      viaNat: true,
      translatedFrom: "network-subnet:203.0.113.10/32",
      translationRules: ["fw-rule:em0:rdr:web"],
      allowedBy: ["fw-rule:em0:pass:web"],
      blockedBy: [],
    });
    expect(result).toContainEqual(
      expect.objectContaining({
        id: "network-if:admin:ui",
        verdict: "blocked",
        path: "rdr",
        viaNat: true,
        allowedBy: ["fw-rule:em0:pass:admin"],
        blockedBy: ["fw-rule:em0:block:admin"],
      })
    );
  });
});
