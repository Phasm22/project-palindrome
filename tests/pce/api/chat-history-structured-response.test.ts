import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { ChatHistoryStore } from "../../../src/pce/api/chat-history-store";
import { createTextAgentResponse } from "../../../src/agent/schemas/agent-response";

const paths: string[] = [];
const stores: ChatHistoryStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop()!, { force: true });
});

describe("chat history structured responses", () => {
  test("persists and restores the complete response envelope", async () => {
    const path = `/tmp/chat-structured-${crypto.randomUUID()}.db`;
    paths.push(path);
    const store = new ChatHistoryStore(path);
    stores.push(store);
    const conversationId = await store.createConversation("user-1", "test");
    const structuredResponse = createTextAgentResponse("Saved answer", {
      state: "READY_READ",
      traceId: "trace-1",
    });

    await store.saveMessage({
      conversationId,
      userId: "user-1",
      aclGroup: "admin",
      role: "assistant",
      content: "Saved answer",
      structuredResponse,
      timestamp: new Date(),
    });

    const [message] = await store.getHistory({ conversationId });
    expect(message.structuredResponse).toEqual(structuredResponse);
  });
});
