import { describe, expect, test } from "bun:test";
import { PfctlFirewallParser } from "../../../src/parsers/security/pfctl-firewall-parser";
import { FirewallIngestionOrchestrator } from "../../../src/pce/ingestion/firewall-ingestion";
import { TwinRelationshipType } from "../../../src/twin/models/relationships";

describe("FirewallIngestionOrchestrator rule relationships", () => {
  test("creates an ALLOWS edge to a known VM host-address subnet that overlaps the rule CIDR", async () => {
    const collectedAt = new Date("2026-07-23T12:00:00.000Z");
    const parser = new PfctlFirewallParser();
    const parsed = await parser.parse(
      {
        rules: [
          "pass in on vtnet0 proto tcp from any to 172.16.0.0/22 port 443",
        ],
        nat: [],
      },
      { source: "test", collectedAt }
    );

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
          }>
        >;
      }
    ).createRuleRelationships.bind(orchestrator);

    // This is the subnet entity connected to a known VM interface in the
    // existing twin. Its ID contains a host address rather than the canonical
    // network address used by the firewall rule.
    const knownVmSubnet = {
      id: "network-subnet:172.16.0.198/22",
      cidr: "172.16.0.198/22",
    };
    const relationships = await createRuleRelationships(
      parsed.entities,
      new Map(),
      new Map(),
      [knownVmSubnet]
    );

    const allowTargets = relationships
      .filter((relationship) => relationship.type === TwinRelationshipType.ALLOWS)
      .map((relationship) => relationship.toId);
    expect(allowTargets).toContain("network-subnet:172.16.0.0/22");
    expect(allowTargets).toContain(knownVmSubnet.id);
  });
});
