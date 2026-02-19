import { test, expect } from "bun:test";
import { classifyIntent } from "../../src/reasoning/intent-classifier";
import { evaluateDialogPolicy, parseConfirmationInput, selectResponseMode } from "../../src/agent/dialog-policy";

test("Destructive action requires confirmation", () => {
  const classification = classifyIntent("destroy vm-12");
  const decision = evaluateDialogPolicy({ intent: classification, confirmation: { confirmed: false } });
  expect(decision.requiresConfirmation).toBe(true);
  expect(decision.nextState).toBe("AWAITING_CONFIRMATION");
  expect(decision.shouldExecute).toBe(false);
});

test("Explicit confirmation allows execution", () => {
  const confirmation = parseConfirmationInput("CONFIRM deadbeef");
  const classification = classifyIntent("destroy vm-12");
  const decision = evaluateDialogPolicy({
    intent: classification,
    confirmation,
    pendingActionId: "deadbeef",
    pendingActionCreatedAt: Date.now(),
  });
  expect(decision.requiresConfirmation).toBe(true);
  expect(decision.shouldExecute).toBe(true);
  expect(decision.nextState).toBe("READY_WRITE");
});

test("Bare CONFIRM does not become action text", () => {
  const confirmation = parseConfirmationInput("CONFIRM");
  expect(confirmation.confirmed).toBe(true);
  expect(confirmation.actionText).toBeUndefined();
});

test("Cancel is parsed explicitly", () => {
  const confirmation = parseConfirmationInput("CANCEL");
  expect(confirmation.confirmed).toBe(false);
  expect(confirmation.cancelled).toBe(true);
});

test("Missing target triggers clarification", () => {
  const classification = classifyIntent("restart the vm");
  const decision = evaluateDialogPolicy({ intent: classification, confirmation: { confirmed: false } });
  expect(decision.needsClarification).toBe(true);
  expect(decision.nextState).toBe("NEED_CLARIFICATION");
});

test("Query defaults to ready read", () => {
  const classification = classifyIntent("list all vms");
  const decision = evaluateDialogPolicy({ intent: classification, confirmation: { confirmed: false } });
  expect(decision.nextState).toBe("READY_READ");
  expect(decision.shouldExecute).toBe(true);
});

test("Stale confirmation is rejected", () => {
  const confirmation = parseConfirmationInput("CONFIRM deadbeef");
  const classification = classifyIntent("destroy vm-12");
  const decision = evaluateDialogPolicy({
    intent: classification,
    confirmation,
    pendingActionId: "deadbeef",
    pendingActionCreatedAt: Date.now() - 20 * 60 * 1000,
  });
  expect(decision.shouldExecute).toBe(false);
  expect(decision.nextState).toBe("AWAITING_CONFIRMATION");
});

test("Write-high action requires CONFIRM <id>", () => {
  const confirmation = parseConfirmationInput("CONFIRM");
  const classification = classifyIntent("create a vm on yin");
  const decision = evaluateDialogPolicy({
    intent: classification,
    confirmation,
    pendingActionId: "deadbeef",
    pendingActionCreatedAt: Date.now(),
  });
  expect(classification.risk).toBe("WRITE_HIGH");
  expect(decision.requiresConfirmation).toBe(true);
  expect(decision.shouldExecute).toBe(false);
  expect(decision.nextState).toBe("AWAITING_CONFIRMATION");
});

test("Mode selection is deterministic", () => {
  const classification = classifyIntent("explain how the firewall works");
  const mode1 = selectResponseMode(classification, { verbosity: "explainer" });
  const mode2 = selectResponseMode(classification, { verbosity: "explainer" });
  expect(mode1).toBe(mode2);
});

test("Ambiguous routing without slots triggers clarification", () => {
  const classification = classifyIntent("tell me about it");
  const decision = evaluateDialogPolicy({
    intent: classification,
    routing: { route: "clarification", confidence: 0.2 },
    confirmation: { confirmed: false },
  });
  expect(decision.decision).toBe("ASK_CLARIFY");
});
