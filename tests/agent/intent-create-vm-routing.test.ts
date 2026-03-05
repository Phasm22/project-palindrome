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
  expect((actionIntent as any)?.name).toBe("apple");
  expect((actionIntent as any)?.node).toBe("yin");
});

test("extracts inline VM name in create prompt", () => {
  const actionIntent = detectActionIntent("create vm sentinel-test on yin");
  expect(actionIntent?.type).toBe("create_vm");
  expect((actionIntent as any)?.name).toBe("sentinel-test");
  expect((actionIntent as any)?.node).toBe("yin");
});

test("keeps create VM name empty when prompt only defines node", () => {
  const actionIntent = detectActionIntent("create a vm on yin");
  expect(actionIntent?.type).toBe("create_vm");
  expect((actionIntent as any)?.name).toBe("");
  expect((actionIntent as any)?.node).toBe("yin");
});

test("extracts quoted VM name in create prompt", () => {
  const actionIntent = detectActionIntent('create a vm named "ops box" on YANG');
  expect(actionIntent?.type).toBe("create_vm");
  expect((actionIntent as any)?.name).toBe("ops box");
  expect((actionIntent as any)?.node).toBe("YANG");
});

test("extracts create VM name when node appears before called-name clause", () => {
  const actionIntent = detectActionIntent("create a vm on yin called miniPal");
  expect(actionIntent?.type).toBe("create_vm");
  expect((actionIntent as any)?.name).toBe("miniPal");
  expect((actionIntent as any)?.node).toBe("yin");
});

test("keeps informational VM existence checks as QUERY", () => {
  const { classification } = classifyAndRoute("is there a vm called apple on yin");
  expect(classification.intent).toBe("QUERY");
});

test("extracts destroy VM target with node", () => {
  const actionIntent = detectActionIntent("destroy aha on yin");
  expect(actionIntent?.type).toBe("destroy_vm");
  expect((actionIntent as any)?.name).toBe("aha");
  expect((actionIntent as any)?.node).toBe("yin");
});
