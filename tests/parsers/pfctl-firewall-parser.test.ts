import { PfctlFirewallParser } from "../../src/parsers/security/pfctl-firewall-parser";
import type { ParserContext } from "../../src/parsers";

const context: ParserContext = {
  source: "test",
  collectedAt: new Date("2025-01-01T00:00:00Z"),
};

test("PfctlFirewallParser uses stable hash in rule IDs", async () => {
  const parser = new PfctlFirewallParser();
  const line = "pass in quick on em0 proto tcp from 10.0.0.1 to 10.0.0.2 port 22";

  const resultA = await parser.parse({ rules: [line], nat: [] }, context);
  const resultB = await parser.parse({ rules: [line], nat: [] }, context);

  expect(resultA.entities).toHaveLength(1);
  expect(resultB.entities).toHaveLength(1);

  const idA = resultA.entities[0].id;
  const idB = resultB.entities[0].id;

  expect(idA).toBe(idB);
  expect(idA).toContain("fw-rule:");
  expect(idA.split(":").length).toBeGreaterThan(6);
});

test("PfctlFirewallParser differentiates rule IDs for different lines", async () => {
  const parser = new PfctlFirewallParser();
  const lineA = "pass in on em0 proto tcp from 10.0.0.1 to 10.0.0.2 port 22";
  const lineB = "pass in on em0 proto tcp from 10.0.0.1 to 10.0.0.2 port 80";

  const result = await parser.parse({ rules: [lineA, lineB], nat: [] }, context);
  expect(result.entities).toHaveLength(2);

  const ids = result.entities.map((e) => e.id);
  expect(new Set(ids).size).toBe(2);
});

test("PfctlFirewallParser parses 'port = service' syntax", async () => {
  const parser = new PfctlFirewallParser();
  const line =
    "pass in log quick on vtnet1 inet proto tcp from <TJs_Computers> to (vtnet0:network) port = ssh flags S/SA keep state";

  const result = await parser.parse({ rules: [line], nat: [] }, context);
  expect(result.entities).toHaveLength(1);

  const entity = result.entities[0];
  expect(entity.type).toBe("firewall_rule");
  expect((entity as any).data?.destinationPort).toBe("ssh");
  expect((entity as any).data?.protocol).toBe("tcp");
});

test("PfctlFirewallParser parses brace port sets", async () => {
  const parser = new PfctlFirewallParser();
  const line =
    "pass in quick on vtnet1 proto tcp from any to (vtnet0:network) port = { ssh domain http https }";

  const result = await parser.parse({ rules: [line], nat: [] }, context);
  expect(result.entities).toHaveLength(1);

  const entity = result.entities[0];
  expect((entity as any).data?.destinationPort).toBe("ssh,domain,http,https");
});
