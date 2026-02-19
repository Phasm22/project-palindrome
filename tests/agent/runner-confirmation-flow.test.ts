import { test, expect } from "bun:test";
import { runAgent } from "../../src/agent/runner";

test("write request returns review + strict confirm prompt", async () => {
  const res = await runAgent("make a vm called apple on yin");
  expect(res.text).toContain("Review pending change:");
  expect(res.text).toContain("Reply with CONFIRM ");
  expect(res.text).toContain("or CANCEL");
});

test("mismatched confirmation id is rejected", async () => {
  const res = await runAgent("CONFIRM wrongid", {
    conversationContext: {
      pendingAction: "destroy vm-12",
      pendingActionId: "deadbeef",
      pendingActionCreatedAt: Date.now(),
      pendingActionExpiresAt: Date.now() + 10 * 60 * 1000,
      pendingActionPreview: "destroy vm-12",
      pendingActionExecuteInput: "destroy vm-12",
    },
  });

  expect(res.text).toContain("does not match");
  expect(res.text).toContain("CONFIRM deadbeef");
});

test("cancel clears pending change", async () => {
  const res = await runAgent("CANCEL", {
    conversationContext: {
      pendingAction: "destroy vm-12",
      pendingActionId: "deadbeef",
      pendingActionCreatedAt: Date.now(),
      pendingActionExpiresAt: Date.now() + 10 * 60 * 1000,
      pendingActionPreview: "destroy vm-12",
      pendingActionExecuteInput: "destroy vm-12",
    },
  });

  expect(res.text).toContain("Cancelled the pending change");
});

test("confirmed id replays pending executable input", async () => {
  const res = await runAgent("CONFIRM deadbeef", {
    conversationContext: {
      pendingAction: "make a vm called apple on yin",
      pendingActionId: "deadbeef",
      pendingActionCreatedAt: Date.now(),
      pendingActionExpiresAt: Date.now() + 10 * 60 * 1000,
      pendingActionPreview: "create vm apple on yin",
      pendingActionExecuteInput: "hi",
    },
  });

  expect(res.text).toContain("Hi");
  expect(res.text).toContain("lab");
});
