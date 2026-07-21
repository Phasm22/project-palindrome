import { describe, expect, test } from "bun:test";
import { detectFirewallIntent } from "../../src/reasoning/detectFirewallIntent";

describe("detectFirewallIntent", () => {
  test("routes wireguard network rule queries to rules_by_chain", () => {
    const intent = detectFirewallIntent("what firewall rules are for the wireguard network?");
    expect(intent).toEqual({ type: "rules_by_chain", chain: "chain:wireguard" });
  });

  test("routes wg shorthand to wireguard chain", () => {
    const intent = detectFirewallIntent("show firewall rules for the wg network");
    expect(intent).toEqual({ type: "rules_by_chain", chain: "chain:wireguard" });
  });

  test("routes source IP access questions to source-aware chain analysis", () => {
    const intent = detectFirewallIntent(
      "What IPs of the WireGuard interface can access the lab network?"
    );
    expect(intent).toEqual({
      type: "sources_accessing_network",
      chain: "chain:wireguard",
      target: "lab network",
    });
  });

  test("routes reachability over wg to chain reachability", () => {
    const intent = detectFirewallIntent("what is reachable from wg?");
    expect(intent).toEqual({ type: "reachability_from_chain", chain: "chain:wireguard" });
  });

  test("keeps explicit chain parsing behavior", () => {
    const intent = detectFirewallIntent("show firewall rules for chain vtnet0");
    expect(intent).toEqual({ type: "rules_by_chain", chain: "chain:vtnet0" });
  });

  test("routes allowed-port path questions to dedicated firewall intent", () => {
    const intent = detectFirewallIntent("what ports are allowed from home network to lab network?");
    expect(intent).toEqual({ type: "allowed_ports_between", from: "home network", to: "lab network" });
  });

  test("keeps a ports-and-hosts policy question on the dedicated firewall intent", () => {
    const intent = detectFirewallIntent(
      "what ports are we allowing from home to lab? and for what hosts"
    );
    expect(intent).toEqual({ type: "allowed_ports_between", from: "home", to: "lab" });
  });

  test("routes alias content questions to dedicated firewall intent", () => {
    const intent = detectFirewallIntent("what all is in the alias tjs computers");
    expect(intent).toEqual({ type: "alias_contents", aliasName: "tjs computers" });
  });

  test("extracts the alias name when it precedes the word 'alias' (natural ordering)", () => {
    const intent = detectFirewallIntent("what's in the WG_VIP alias?");
    expect(intent).toEqual({ type: "alias_contents", aliasName: "WG_VIP" });
  });

  test("does not swallow the rest of the sentence as the alias name (regression)", () => {
    // Previously: aliasName ended up as "were removed, and are any of them
    // internet-exposed" because the greedy "alias <name>" regex had nothing to
    // stop it at — see fuzz-campaign-2026-07-21.md finding F-10.
    const intent = detectFirewallIntent(
      "What VMs would be affected if the WG_VIP alias were removed, and are any of them internet-exposed?"
    );
    expect(intent?.type).not.toBe("alias_contents");
  });

  test("does not treat 'what would break if I deleted alias X' as an alias-contents query", () => {
    const intent = detectFirewallIntent("What would break if I deleted the Home_DNS alias?");
    expect(intent?.type).not.toBe("alias_contents");
  });
});
