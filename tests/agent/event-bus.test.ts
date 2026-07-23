import { test, expect } from "bun:test";
import { z } from "zod";
import { AgentEventBus, emitToolProgress, runWithAgentSession } from "../../src/agent/event-bus";
import { AgentEventDataSchema } from "../../src/agent/event-payloads";
import { emitFinalEvent, emitStepEvent } from "../../src/agent/handlers/emit-helpers";
import { executeToolCall } from "../../src/agent/tool-executor";
import { actionRegistry } from "../../src/actions/registry";
import { ActionTool } from "../../src/tools/ActionTool";

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

test("tool progress inherits the active agent session", async () => {
  const eventBus = AgentEventBus.getInstance();
  let received: any;
  const unsubscribe = eventBus.onType("tool:progress", (event) => {
    if (event.data.message === "Scoped progress") received = event;
  });

  try {
    await runWithAgentSession("scoped-session", async () => {
      await Promise.resolve();
      emitToolProgress({
        toolName: "action",
        status: "verifying",
        message: "Scoped progress",
      });
    });
  } finally {
    unsubscribe();
  }

  expect(received?.sessionId).toBe("scoped-session");
});

test("concurrent ActionTool progress stays scoped to its originating session", async () => {
  const actionName = "test.session_scoped_progress";
  if (!actionRegistry.get(actionName)) {
    actionRegistry.register({
      name: actionName,
      description: "Fake action for session-scoped progress tests",
      schema: z.object({}).passthrough(),
      execute: async () => {
        await Promise.resolve();
        return { success: true };
      },
    });
  }

  const eventBus = AgentEventBus.getInstance();
  const sessionIds: Array<string | undefined> = [];
  const unsubscribe = eventBus.onType("tool:progress", (event) => {
    if (event.data.action === actionName) {
      sessionIds.push(event.sessionId);
    }
  });

  try {
    await Promise.all([
      executeToolCall(
        { toolName: "action", parameters: { action: actionName, params: {} } },
        [new ActionTool()],
        { sessionId: "action-session-a" }
      ),
      executeToolCall(
        { toolName: "action", parameters: { action: actionName, params: {} } },
        [new ActionTool()],
        { sessionId: "action-session-b" }
      ),
    ]);
  } finally {
    unsubscribe();
  }

  expect(sessionIds).toHaveLength(6);
  expect(sessionIds.filter((sessionId) => sessionId === "action-session-a")).toHaveLength(3);
  expect(sessionIds.filter((sessionId) => sessionId === "action-session-b")).toHaveLength(3);
});

test("connection updates validate as structured agent events", () => {
  const parsed = AgentEventDataSchema.parse({
    type: "connection:update",
    phase: "complete",
    resource: "web-1",
    endpoints: [{
      id: "nginx:http:80:dns:web-1.prox",
      service: "nginx",
      protocol: "http",
      host: "web-1.prox",
      addressType: "dns",
      port: 80,
      value: "http://web-1.prox:80/",
      status: "verified",
    }],
  });

  expect(parsed.type).toBe("connection:update");
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
