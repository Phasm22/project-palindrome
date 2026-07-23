import { classifyAndRoute } from "../../src/reasoning/intent-router";

test("clear informational queries route to QUERY not clarification", () => {
  const phrases = [
    "I want to see what IP sentinel Zero is",
    "I want to know about my lab",
    "are there any firewall rules for the wireguard network?",
  ];
  for (const p of phrases) {
    const { classification, routing } = classifyAndRoute(p);
    expect(classification.type).toBe("QUERY");
    expect(routing.route).not.toBe("clarification");
    expect(routing.route).toMatch(/direct_handler|llm_reasoning/);
  }
});

test("are there any firewall rules gets QUERY with domain set", () => {
  const { classification, routing } = classifyAndRoute("are there any firewall rules for the wireguard network?");
  expect(classification.type).toBe("QUERY");
  expect(routing.route).not.toBe("clarification");
  expect(["firewall", "network"]).toContain(classification.metadata?.domain);
});

test("'give me' and imperative diagnostic phrasing bypass the observe/diagnose/change clarification", () => {
  // These were previously landing on the generic "Are you asking to observe,
  // diagnose, change, explain, or plan?" clarification even though they're
  // clearly read-only asks — see fuzz-campaign-2026-07-21.md.
  const phrases = [
    "Give me a summary of the whole cluster.",
    "Ping 172.16.0.1 for me.",
    "Traceroute to 8.8.8.8.",
    "Run a full health diagnostic on windowsVM.",
    "Why can't I reach pihole, can you diagnose it?",
    "vms???? on yang???? pls?????",
  ];
  for (const p of phrases) {
    const { routing } = classifyAndRoute(p);
    expect(routing.route).not.toBe("clarification");
  }
});
