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

  test("routes 'list all aliases' to a dedicated alias_list intent, not the generic rule dump (A-OP-02)", () => {
    // Previously: extractAliasName can't find a name in plural "aliases", so this
    // fell through everything and hit the generic list_rules fallback (matched
    // by the bare word "list") — a full rules dump instead of the aliases list.
    const intent = detectFirewallIntent("List all OPNsense firewall aliases.");
    expect(intent).toEqual({ type: "alias_list" });
  });

  test("'what aliases exist' also routes to alias_list", () => {
    expect(detectFirewallIntent("What aliases exist on the firewall?")).toEqual({ type: "alias_list" });
  });

  test("does not regress the singular-alias-with-a-name case even when 'all' appears elsewhere in the sentence", () => {
    // "what ALL is in the alias X" — "all" modifies "is in", not "aliases";
    // the specific alias name must still win.
    const intent = detectFirewallIntent("what all is in the alias tjs computers");
    expect(intent).toEqual({ type: "alias_contents", aliasName: "tjs computers" });
  });

  test("resolves a bare camelCase VM display name for exposure questions (A-TQ-21)", () => {
    // Previously: extractVmId only recognized "vm123"/"compute-vm:..." — a real
    // display name like "windowsVM" fell through, so exposure_map came back
    // with vmId: undefined (the whole-cluster map) instead of being scoped.
    const intent = detectFirewallIntent("Is windowsVM exposed to the internet?");
    expect(intent).toEqual({ type: "exposure_map", vmId: "windowsVM" });
  });

  test("resolves a 'the X VM' phrasing for exposure questions (A-TQ-23)", () => {
    const intent = detectFirewallIntent("What's the exposure path for the opnsense VM?");
    expect(intent).toEqual({ type: "exposure_map", vmId: "opnsense" });
  });

  test("routes a port-attribution question to rules_by_port instead of the generic rule dump (C-03)", () => {
    // Previously: no dedicated intent for "which rule permits port N" at all —
    // fell through to the generic list_rules fallback (matched by "rule").
    const intent = detectFirewallIntent("Which firewall rule permits access to port 8006?");
    expect(intent).toEqual({ type: "rules_by_port", port: "8006" });
  });

  test("does not regress the 'ports allowed from X to Y' scope question (no literal port number)", () => {
    const intent = detectFirewallIntent("what ports are allowed from home network to lab network?");
    expect(intent?.type).toBe("allowed_ports_between");
  });
});
