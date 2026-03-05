import { test, expect, beforeEach, afterEach } from "bun:test";
import { runAgent } from "../../src/agent/runner";
import { AgentEventBus, type AgentEvent } from "../../src/agent/event-bus";
import { installIsolatedObservabilityStores } from "../helpers/isolated-observability";

let cleanupObservability: (() => void) | null = null;

beforeEach(() => {
  cleanupObservability = installIsolatedObservabilityStores("runner-confirmation-flow").cleanup;
});

afterEach(() => {
  cleanupObservability?.();
  cleanupObservability = null;
});

async function runAgentWithFinalEvent(input: string, options: Record<string, any> = {}) {
  const sessionId = options.sessionId ?? `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const eventBus = AgentEventBus.getInstance();
  let finalEvent: AgentEvent | undefined;
  const unsubscribe = eventBus.onType("agent:final", (event) => {
    if (event.sessionId === sessionId) {
      finalEvent = event;
    }
  });

  try {
    const response = await runAgent(input, { ...options, sessionId });
    return { response, finalEvent };
  } finally {
    unsubscribe();
  }
}

test("write request returns review + strict confirm prompt", async () => {
  const res = await runAgent("make a vm called apple on yin");
  expect(res.text).toContain("Review pending change:");
  expect(res.text).toContain("Reply with CONFIRM ");
  expect(res.text).toContain("or CANCEL");
});

test("destroy summary keeps explicit VM name", async () => {
  const res = await runAgent("destroy vm qeak on yang");
  expect(res.text).toContain("Review pending change:");
  expect(res.text.toLowerCase()).toContain("destroy qeak");
  expect(res.text).toContain("on YANG");
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

  expect((res.text ?? "").length).toBeGreaterThan(0);
  expect(res.text).not.toContain("There is no pending action");
}, { timeout: 10000 });

test("clarification continuation stores executable pending action input", async () => {
  const turn1 = await runAgentWithFinalEvent("create a vm");
  expect(turn1.response.text).toContain("What is the target environment for the VM?");

  const turn2 = await runAgentWithFinalEvent("yang", {
    conversationState: "NEED_CLARIFICATION",
    conversationHistory: [
      { role: "user", content: "create a vm" },
      { role: "assistant", content: "What is the target environment for the VM?" },
    ],
  });

  expect(turn2.response.text).toContain("Review pending change:");
  const pendingExecuteInput = (turn2.finalEvent as any)?.data?.conversationContext?.pendingActionExecuteInput;
  expect(pendingExecuteInput).toBe("create a vm on yang");
  expect(pendingExecuteInput).not.toBe("yang");
});
