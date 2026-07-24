import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { runAgent } from "../../src/agent/runner";
import { AgentEventBus, type AgentEvent } from "../../src/agent/event-bus";
import { ApplicationLifecycleTool } from "../../src/tools/actions/ApplicationLifecycleTool";
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
}, { timeout: 15000 });

test("destroy summary keeps explicit VM name", async () => {
  const res = await runAgent("destroy vm qeak on yang");
  expect(res.text).toContain("Review pending change:");
  expect(res.text.toLowerCase()).toContain("destroy qeak");
  expect(res.text).toContain("on YANG");
}, { timeout: 15000 });

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

test("bare test input returns a liveness response without clarification", async () => {
  const { response, finalEvent } = await runAgentWithFinalEvent("test");

  expect(response.text).toBe("Agent is online.");
  expect(response.structuredResponse.answer.summary).toBe("Agent is online.");
  expect((finalEvent as any)?.data?.structuredResponse?.answer?.summary).toBe("Agent is online.");
}, { timeout: 15000 });

// This path replays a pending executable input through the general chat/
// generation route (handleExecuteWithAcl -> getOpenAIClient), unlike the
// other tests in this file which resolve through deterministic write/
// destroy-request templates - it has no path that succeeds without a real
// OpenAI key.
test.skipIf(!process.env.OPENAI_API_KEY)("confirmed id replays pending executable input", async () => {
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
}, { timeout: 15000 });

test("compound application request asks for a node before confirmation", async () => {
  const request =
    "Create a VM called Samsung Open Ports 22 and eighty and four three and put an Nginx server up with the picture of Of A Grand piano. Also put the VM under the ops domain.";
  const turn1 = await runAgentWithFinalEvent(request);

  expect(turn1.response.text).toBe("What is the target environment for the VM?");

  const turn2 = await runAgentWithFinalEvent("proxBig", {
    conversationState: "NEED_CLARIFICATION",
    conversationHistory: [
      { role: "user", content: request },
      { role: "assistant", content: turn1.response.text },
    ],
  });

  expect(turn2.response.text).toContain("Review pending change: deploy application Samsung");
  expect(turn2.response.text).toContain("VM: Samsung on proxBig");
  expect(turn2.response.text).toContain("Services: Nginx");
  expect(turn2.response.text).toContain("Firewall ports: 22, 80, 43");
  expect(turn2.response.text).toContain("Generated image: A Grand piano");
  expect(turn2.response.text).toContain("Domain: samsung.ops.prox");
}, { timeout: 15000 });

test("confirmed compound request executes one deterministic lifecycle manifest", async () => {
  const request =
    "Create a VM called Samsung Open Ports 22, 443, and 80. create the Nginx server with the picture of Of A Grand piano. Also put the VM under the ops domain. on yin";
  const executeSpy = spyOn(ApplicationLifecycleTool.prototype, "execute").mockResolvedValue({
    data: { success: true },
    durationMs: 1,
  });

  try {
    const result = await runAgent("CONFIRM deadbeef", {
      conversationState: "AWAITING_CONFIRMATION",
      conversationContext: {
        pendingAction: request,
        pendingActionId: "deadbeef",
        pendingActionCreatedAt: Date.now(),
        pendingActionExpiresAt: Date.now() + 10 * 60 * 1000,
        pendingActionPreview: "deploy application Samsung",
        pendingActionExecuteInput: request,
      },
    });

    expect(result.text).toContain("Application deployed");
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(executeSpy.mock.calls[0]?.[0]).toMatchObject({
      schemaVersion: "1",
      operation: "deploy",
      applications: [{
        name: "samsung",
        domain: "samsung.ops.prox",
        vms: [{
          name: "samsung",
          node: "yin",
          services: ["nginx"],
          firewall: {
            rules: [
              { port: 22 },
              { port: 443 },
              { port: 80 },
            ],
          },
        }],
      }],
    });
  } finally {
    executeSpy.mockRestore();
  }
}, { timeout: 15000 });
