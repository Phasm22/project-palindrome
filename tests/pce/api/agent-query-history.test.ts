import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { PceApiServer, type PceApiServerOptions, type PceApiServerDependencies } from "../../../src/pce/api/server";
import { ChatHistoryStore } from "../../../src/pce/api/chat-history-store";
import { MetricsCollector, QueryMetrics, ErrorMetrics } from "../../../src/pce/metrics";
import type { DependencyHealthCheck } from "../../../src/pce/api/types";
import { AgentEventBus } from "../../../src/agent/event-bus";
import { runAgent } from "../../../src/agent/runner";

class MockOrchestrator implements PceApiServerDependencies["orchestrator"] {
  async query() {
    return {
      answer: "ok",
      queryType: "HYBRID",
      fallbackMode: null,
      sources: [],
      metadata: { tokensUsed: 0, chunksRetrieved: 0 },
      fusionMetrics: {
        vectorResults: 0,
        graphResults: 0,
        fusedResults: 0,
        prunedResults: 0,
        avgTotalScore: 0,
      },
      context: { semanticChunks: [], structuralPaths: [], provenance: [] },
      sTotalScore: 0,
    } as any;
  }
}

const servers: PceApiServer[] = [];
const tempPaths: string[] = [];
const stores: ChatHistoryStore[] = [];

async function startAgentTestServer(
  options: Partial<PceApiServerOptions> = {},
  overrides: Partial<PceApiServerDependencies> = {}
) {
  const dbPath = `/tmp/agent-query-history-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  tempPaths.push(dbPath);
  const chatHistoryStore = overrides.chatHistoryStore ?? new ChatHistoryStore(dbPath);
  stores.push(chatHistoryStore);
  const metricsCollector = overrides.metricsCollector ?? new MetricsCollector();
  const queryMetrics = overrides.queryMetrics ?? new QueryMetrics(metricsCollector);
  const errorMetrics = overrides.errorMetrics ?? new ErrorMetrics(metricsCollector);
  const dependencyChecks =
    overrides.dependencyChecks ?? ([{ name: "vector_store", check: async () => true }] satisfies DependencyHealthCheck[]);

  const server = new PceApiServer(
    {
      orchestrator: overrides.orchestrator ?? new MockOrchestrator(),
      agentRunner: overrides.agentRunner,
      chatHistoryStore,
      metricsCollector,
      queryMetrics,
      errorMetrics,
      dependencyChecks,
    },
    { enableIngestionScheduler: false, port: 0, ...options }
  );

  await server.start();
  const baseUrl = `http://localhost:${server.getPort()}`;
  return { server, baseUrl, chatHistoryStore };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error("Timed out waiting for condition");
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    if (server) await server.stop();
  }
  while (stores.length) {
    const store = stores.pop();
    if (store) store.close();
  }
  while (tempPaths.length) {
    const path = tempPaths.pop();
    if (path) rmSync(path, { force: true });
  }
});

describe("agent query history contract", () => {
  it("passes loaded conversation inputs to the injected runner and persists matching final events", async () => {
    const captured: Array<{ input: string; options: any }> = [];
    const agentRunner: typeof runAgent = async (input, optionsOrStream) => {
      const options = typeof optionsOrStream === "boolean" ? { stream: optionsOrStream } : optionsOrStream ?? {};
      captured.push({ input, options });
      AgentEventBus.getInstance().emit({
        type: "agent:final",
        sessionId: options.sessionId,
        timestamp: Date.now(),
        data: {
          type: "agent:final",
          text: "Agent completed",
          totalSteps: 1,
          totalToolCalls: 0,
          durationMs: 5,
          conversationState: "FOLLOWUP",
          conversationContext: { activeHost: "yang" },
          memorySource: "policy_inference",
          memoryConfidence: 0.8,
        },
      });
      return { text: "Agent completed" } as any;
    };

    const { server, baseUrl, chatHistoryStore } = await startAgentTestServer({}, { agentRunner });
    servers.push(server);

    const conversationId = await chatHistoryStore.createConversation("user-1", "existing");
    await chatHistoryStore.saveMessage({
      conversationId,
      userId: "user-1",
      aclGroup: "admin",
      role: "user",
      content: "previous question",
      timestamp: new Date(Date.now() - 1000),
    });
    await chatHistoryStore.saveMessage({
      conversationId,
      userId: "user-1",
      aclGroup: "admin",
      role: "assistant",
      content: "previous answer",
      timestamp: new Date(Date.now() - 500),
    });
    await chatHistoryStore.updateConversationState(conversationId, "AWAITING_CONFIRMATION", "user-1");
    await chatHistoryStore.setConversationContext(
      conversationId,
      { pendingActionId: "deadbeef", pendingAction: "destroy vm test" },
      "policy_inference",
      0.9,
      "user-1"
    );

    const res = await fetch(`${baseUrl}/api/agent/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "confirm it",
        userId: "user-1",
        aclGroup: "admin",
        conversationId,
        sessionId: "history-session",
      }),
    });

    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.input).toBe("confirm it");
    expect(captured[0]?.options?.conversationState).toBe("AWAITING_CONFIRMATION");
    expect(captured[0]?.options?.conversationContext?.pendingActionId).toBe("deadbeef");
    expect(captured[0]?.options?.conversationHistory).toEqual([
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
    ]);

    await waitFor(async () => {
      const messages = await chatHistoryStore.getHistory({ conversationId, userId: "user-1" });
      return messages.some((message) => message.role === "assistant" && message.content === "Agent completed");
    });

    const messages = await chatHistoryStore.getHistory({ conversationId, userId: "user-1" });
    expect(messages.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
      { role: "user", content: "confirm it" },
      { role: "assistant", content: "Agent completed" },
    ]);

    const conversation = await chatHistoryStore.getConversation(conversationId, "user-1");
    expect(conversation?.state).toBe("FOLLOWUP");
    const context = await chatHistoryStore.getConversationContext(conversationId);
    expect(context.activeHost).toBe("yang");
  });

  it("ignores non-matching final events when persisting assistant output", async () => {
    const agentRunner: typeof runAgent = async (_input, optionsOrStream) => {
      const options = typeof optionsOrStream === "boolean" ? { stream: optionsOrStream } : optionsOrStream ?? {};
      AgentEventBus.getInstance().emit({
        type: "agent:final",
        sessionId: "different-session",
        timestamp: Date.now(),
        data: {
          type: "agent:final",
          text: "wrong session",
          totalSteps: 1,
          totalToolCalls: 0,
          durationMs: 5,
        },
      });
      return { text: options.sessionId ?? "done" } as any;
    };

    const { server, baseUrl, chatHistoryStore } = await startAgentTestServer({}, { agentRunner });
    servers.push(server);

    const res = await fetch(`${baseUrl}/api/agent/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "status",
        userId: "user-2",
        aclGroup: "admin",
        sessionId: "expected-session",
      }),
    });

    expect(res.status).toBe(200);

    await Bun.sleep(100);
    const conversations = await chatHistoryStore.getConversations("user-2");
    expect(conversations).toHaveLength(1);
    const messages = await chatHistoryStore.getHistory({ conversationId: conversations[0]?.id, userId: "user-2" });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("status");
  });
});
