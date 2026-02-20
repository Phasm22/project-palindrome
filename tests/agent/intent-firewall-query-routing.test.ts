import { expect, test } from "bun:test";
import { detectActionIntent } from "../../src/reasoning/action-intents";
import { classifyAndRoute } from "../../src/reasoning/intent-router";

test("question-style allowed ports query is not treated as action", () => {
  const query = "what ports are allowed in from the home network to the lab network?";
  const actionIntent = detectActionIntent(query);
  const { classification, routing } = classifyAndRoute(query);

  expect(actionIntent).toBeNull();
  expect(classification.intent).toBe("QUERY");
  expect(routing.route).not.toBe("clarification");
});

test("imperative allow port command remains action intent", () => {
  const query = "allow port 443 on vm opsbox";
  const actionIntent = detectActionIntent(query);

  expect(actionIntent?.type).toBe("configure_firewall");
  expect((actionIntent as any)?.vmName).toBe("opsbox");
});
