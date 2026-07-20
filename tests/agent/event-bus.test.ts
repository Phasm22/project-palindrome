import { test, expect } from "bun:test";
import { AgentEventBus, emitToolProgress } from "../../src/agent/event-bus";
import { emitFinalEvent, emitStepEvent } from "../../src/agent/handlers/emit-helpers";

test("emitStepEvent emits a discriminator-typed payload", () => {
  const eventBus = AgentEventBus.getInstance();
  let received: any;
  const unsubscribe = eventBus.onType("agent:step", (event) => {
    if (event.sessionId === "step-session") received = event;
  });

  try {
    emitStepEvent(eventBus, "step-session", {
      step: 1,
      maxSteps: 3,
      userInput: "check cluster status",
    });
  } finally {
    unsubscribe();
  }

  expect(received?.data?.type).toBe("agent:step");
  expect(received?.data?.userInput).toBe("check cluster status");
});

test("emitToolProgress emits a discriminator-typed payload", () => {
  const eventBus = AgentEventBus.getInstance();
  let received: any;
  const unsubscribe = eventBus.onType("tool:progress", (event) => {
    received = event;
  });

  try {
    emitToolProgress({
      toolName: "proxmox_write",
      action: "start_vm",
      status: "running",
      message: "Starting vm",
      progress: 0.5,
    }, "progress-session");
  } finally {
    unsubscribe();
  }

  expect(received?.sessionId).toBe("progress-session");
  expect(received?.data?.type).toBe("tool:progress");
  expect(received?.data?.toolName).toBe("proxmox_write");
});

test("emitFinalEvent always emits a structured response", () => {
  const eventBus = AgentEventBus.getInstance();
  let received: any;
  const unsubscribe = eventBus.onType("agent:final", (event) => {
    if (event.sessionId === "final-session") received = event;
  });

  try {
    emitFinalEvent(eventBus, "final-session", Date.now(), "Use `node-a`", {
      conversationState: "READY_READ",
      traceId: "trace-1",
    });
  } finally {
    unsubscribe();
  }

  expect(received.data.structuredResponse.version).toBe("2");
  expect(received.data.structuredResponse.answer.summary).toBe("Use `node-a`");
  expect(received.data.structuredResponse.conversation.state).toBe("READY_READ");
  expect(received.data.structuredResponse.evidence.traceId).toBe("trace-1");
});

test("emitFinalEvent preserves multiline text without markdown parsing", () => {
  const eventBus = AgentEventBus.getInstance();
  let received: any;
  const unsubscribe = eventBus.onType("agent:final", (event) => {
    if (event.sessionId === "multiline-session") received = event;
  });

  try {
    emitFinalEvent(eventBus, "multiline-session", Date.now(), "Review change\nCONFIRM `abc123`\nCANCEL");
  } finally {
    unsubscribe();
  }

  expect(received.data.structuredResponse.answer.summary).toBe("Review change");
  expect(received.data.structuredResponse.answer.sections).toEqual([
    { type: "text", data: "CONFIRM `abc123`\nCANCEL" },
  ]);
});
