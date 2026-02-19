import { test, expect } from "bun:test";
import { classifyAndRoute } from "../../src/reasoning/intent-router";
import { detectActionIntent } from "../../src/reasoning/action-intents";

test("routes 'make a vm called apple on yin' as ACTION", () => {
  const { classification, routing } = classifyAndRoute("make a vm called apple on yin");
  const actionIntent = detectActionIntent("make a vm called apple on yin");

  expect(classification.intent).toBe("ACTION");
  expect(classification.metadata?.actionType).toBe("create");
  expect(routing.route).not.toBe("clarification");
  expect(actionIntent?.type).toBe("create_vm");
  expect((actionIntent as any)?.node).toBe("yin");
});

test("keeps informational VM existence checks as QUERY", () => {
  const { classification } = classifyAndRoute("is there a vm called apple on yin");
  expect(classification.intent).toBe("QUERY");
});
