import { describe, expect, test } from "bun:test";
import {
  buildUfwRuleCommand,
  ConfigureFirewallSchema,
  isValidFirewallSource,
} from "../../src/actions/services/configure-firewall";

describe("source-aware firewall rules", () => {
  test("accepts IP addresses and bounded CIDRs", () => {
    expect(isValidFirewallSource("any")).toBe(true);
    expect(isValidFirewallSource("172.16.0.184/32")).toBe(true);
    expect(isValidFirewallSource("2001:db8::/64")).toBe(true);
    expect(isValidFirewallSource("172.16.0.0/99")).toBe(false);
  });

  test("rejects shell input", () => {
    const result = ConfigureFirewallSchema.safeParse({
      vmName: "stark",
      rules: [
        {
          port: 80,
          protocol: "tcp",
          action: "allow",
          source: "172.16.0.184; touch /tmp/bad",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("builds a source-restricted UFW command", () => {
    expect(
      buildUfwRuleCommand({
        port: 80,
        protocol: "tcp",
        action: "allow",
        source: "172.16.0.184/32",
      })
    ).toBe("ufw allow from 172.16.0.184/32 to any port 80 proto tcp");
  });
});
