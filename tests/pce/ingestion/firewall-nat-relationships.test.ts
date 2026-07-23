import { describe, expect, test } from "bun:test";
import { PfctlFirewallParser } from "../../../src/parsers/security/pfctl-firewall-parser";
import { FirewallIngestionOrchestrator } from "../../../src/pce/ingestion/firewall-ingestion";
import { TwinRelationshipType } from "../../../src/twin/models/relationships";

describe("FirewallIngestionOrchestrator NAT relationships", () => {
  test("creates an rdr translation edge and preserves both address/port pairs", async () => {
    const collectedAt = new Date("2026-07-23T12:00:00.000Z");
    const parser = new PfctlFirewallParser();
    const parsed = await parser.parse(
      {
        rules: [],
        nat: [
          "rdr on em0 proto tcp from any to 203.0.113.10 port 80 -> 192.168.1.10 port 8080",
        ],
      },
      { source: "test", collectedAt }
    );

    const rule = parsed.entities[0];
    expect(rule?.data).toMatchObject({
      action: "rdr",
      destination: "203.0.113.10",
      destinationPort: "80",
      translationTarget: "192.168.1.10",
      translationPort: "8080",
    });

    const orchestrator = new FirewallIngestionOrchestrator();
    const createRuleRelationships = (
      orchestrator as unknown as {
        createRuleRelationships: (
          entities: typeof parsed.entities,
          aliases: Map<string, string[]>,
          interfaces: Map<string, string[]>,
          subnets: Array<{ id: string; cidr: string }>
        ) => Promise<
          Array<{
            type: TwinRelationshipType;
            fromId: string;
            toId: string;
            metadata?: Record<string, unknown>;
          }>
        >;
      }
    ).createRuleRelationships.bind(orchestrator);

    const relationships = await createRuleRelationships(
      parsed.entities,
      new Map(),
      new Map(),
      []
    );

    expect(relationships).toContainEqual(
      expect.objectContaining({
        type: TwinRelationshipType.TRANSLATES_TO,
        fromId: "network-subnet:203.0.113.10/32",
        toId: "network-subnet:192.168.1.10/32",
        metadata: expect.objectContaining({
          ruleId: rule?.id,
          ruleType: "rdr",
          originalPort: "80",
          translatedPort: "8080",
        }),
      })
    );
  });
});
