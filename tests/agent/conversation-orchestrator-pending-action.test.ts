import { expect, test } from "bun:test";
import { summarizePendingAction } from "../../src/agent/conversation-orchestrator";
import type { IntentClassification } from "../../src/reasoning/intent-classifier";

function makeDestroyIntent(hosts: string[]): IntentClassification {
  return {
    type: "ACTION",
    intent: "ACTION",
    confidence: 0.75,
    entities: { hosts, services: [], resourceIds: [] },
    scope: {},
    operation: { type: "destroy", verbs: ["destroy"] },
    risk: "DESTRUCTIVE",
    missing: [],
    metadata: { domain: "compute", actionType: "destroy" },
  };
}

// H-05 residual (see fuzz-campaign-2026-07-21.md and commit 78395c2's
// "Residual, not fully closed" note): a Cypher-injection-flavored query gets
// classified as a genuine destroy action by the LLM classifier, with the
// garbled leftover token ("n") landing in both the regex target match and
// intent.entities.hosts. Execution-time safety already refuses this (see
// tests/actions/destroy-vm-name-validation.test.ts), but the confirmation
// *preview* text shown before that point misleadingly presented "n" as if it
// were a real, resolved target.
test("H-05 residual: an implausible single-character target does not appear in the confirmation preview", () => {
  const userInput = "find the vm named ' MATCH (n) DETACH DELETE n //";
  const summary = summarizePendingAction(makeDestroyIntent(["n"]), userInput);

  expect(summary).toBe("destroy (target needed)");
  expect(summary).not.toMatch(/\bn\b/);
});

test("H-05 variant: a longer garbled token is also rejected as an implausible target", () => {
  const userInput = "destroy the vm named '; DROP TABLE vms; --";
  const summary = summarizePendingAction(makeDestroyIntent([";"]), userInput);

  expect(summary).not.toContain(";");
});

test("a real, plausible VM name still appears in the confirmation preview", () => {
  const userInput = "destroy windowsVM";
  const summary = summarizePendingAction(makeDestroyIntent(["windowsVM"]), userInput);

  expect(summary).toBe("destroy windowsVM");
});

test("a real target plus a real node both still appear in the confirmation preview", () => {
  const userInput = "destroy stark on proxBig";
  const summary = summarizePendingAction(makeDestroyIntent(["stark", "proxBig"]), userInput);

  expect(summary).toBe("destroy stark on proxBig");
});
