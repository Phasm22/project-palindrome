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
