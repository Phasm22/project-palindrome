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

  test("routes alias content questions to dedicated firewall intent", () => {
    const intent = detectFirewallIntent("what all is in the alias tjs computers");
    expect(intent).toEqual({ type: "alias_contents", aliasName: "tjs computers" });
  });
});
