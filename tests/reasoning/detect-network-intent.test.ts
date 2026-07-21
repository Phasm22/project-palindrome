import { describe, expect, test } from "bun:test";
import { detectNetworkIntent } from "../../src/reasoning/detectNetworkIntent";

describe("detectNetworkIntent bare MAC-style interface lookup (B-06)", () => {
  test("recognizes a bare 'what is enx...?' with no network/interface framing", () => {
    // Previously: no "network"/"interface"/"nic" keyword present at all, so this
    // returned null and fell through to the EXECUTE/LLM path, which hallucinated
    // a plausible-looking answer instead of querying the twin.
    const intent = detectNetworkIntent("what is enx000ec698587a?");
    expect(intent).toEqual({ type: "interface_lookup", interfaceName: "enx000ec698587a" });
  });

  test("still recognizes the already-working 'what network interface is this?' framing", () => {
    const intent = detectNetworkIntent("what network interface is this?: enx5091e36863e1");
    expect(intent).toEqual({ type: "interface_lookup", interfaceName: "enx5091e36863e1" });
  });

  test("is case-insensitive on the hex portion", () => {
    const intent = detectNetworkIntent("what is ENX000EC698587A?");
    expect(intent?.type).toBe("interface_lookup");
  });

  test("does not match a similarly-shaped but non-MAC token", () => {
    const intent = detectNetworkIntent("what is enxample?");
    expect(intent?.type).not.toBe("interface_lookup");
  });
});

describe("detectNetworkIntent routing-table bypass (A-OP-09)", () => {
  test("does not swallow 'routing table' questions into the generic interface dump", () => {
    // Previously: the "routing" keyword alone routed to describe_network (a
    // network_list_interfaces dump), so the EXECUTE/LLM path — which could
    // call opnsense_readonly's diagnostics_routing_table action — never saw
    // the query at all.
    const intent = detectNetworkIntent("What's OPNsense's routing table look like?");
    expect(intent).toBeNull();
  });

  test("still routes plain 'subnet' questions to describe_network", () => {
    const intent = detectNetworkIntent("What subnet is the lab network on?");
    expect(intent?.type).toBe("describe_network");
  });

  test("still routes non-table 'routing' questions to describe_network", () => {
    const intent = detectNetworkIntent("How does routing work on this network?");
    expect(intent?.type).toBe("describe_network");
  });
});
