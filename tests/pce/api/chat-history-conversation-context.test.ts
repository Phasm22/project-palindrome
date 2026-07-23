import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { ChatHistoryStore } from "../../../src/pce/api/chat-history-store";

const paths: string[] = [];
const stores: ChatHistoryStore[] = [];

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop()!, { force: true });
});

function makeStore(): ChatHistoryStore {
  const path = `/tmp/chat-context-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new ChatHistoryStore(path);
  stores.push(store);
  return store;
}

describe("conversation context persistence (G-08 identity round-trip)", () => {
  // fuzz-campaign-2026-07-21.md flagged G-08 ("call me Ripley" acknowledged,
  // but the very next turn's "what's my name?" got "I don't have your name
  // yet") as a possible server-side session-storage bug. Live investigation
  // this session found the store itself round-trips correctly; the
  // reproduction only failed because it (and the original fuzz harness's
  // multi-turn runner) never threaded the `conversationId` returned by turn
  // 1 into turn 2's request — same `sessionId` alone was never the
  // persistence key. `POST /api/agent/query` creates a brand-new,
  // context-free conversation whenever `conversationId` is omitted,
  // regardless of `sessionId`/`userId` reuse, matching how the real
  // dashboard client (`dashboard/js/chat.js`) always forwards
  // `conversationId` on every turn. These tests lock in the correct,
  // already-working contract at the store layer.
  test("a name set via setConversationContext is readable back by conversationId on a later call", async () => {
    const store = makeStore();
    const conversationId = await store.createConversation("user-1", "test");

    await store.setConversationContext(conversationId, { userName: "Ripley" }, "user_explicit", 0.95, "user-1");

    const context = await store.getConversationContext(conversationId);
    expect(context.userName).toBe("Ripley");
  });

  test("a brand-new conversation (no conversationId threaded) never sees a prior conversation's context", async () => {
    const store = makeStore();
    const firstConversationId = await store.createConversation("user-1", "turn 1");
    await store.setConversationContext(firstConversationId, { userName: "Ripley" }, "user_explicit", 0.95, "user-1");

    // Simulates a second turn that reuses the same userId but never passes
    // the conversationId back — i.e. what happens if a caller relies on
    // sessionId reuse alone instead of the conversationId contract.
    const secondConversationId = await store.createConversation("user-1", "turn 2");
    const context = await store.getConversationContext(secondConversationId);

    expect(context.userName).toBeUndefined();
    expect(secondConversationId).not.toBe(firstConversationId);
  });

  test("partial context updates preserve previously-set fields (COALESCE upsert)", async () => {
    const store = makeStore();
    const conversationId = await store.createConversation("user-1", "test");

    await store.setConversationContext(conversationId, { userName: "Ripley" }, "user_explicit", 0.95, "user-1");
    await store.setConversationContext(conversationId, { activeHost: "proxBig" }, "tool_verified", 0.8, "user-1");

    const context = await store.getConversationContext(conversationId);
    expect(context.userName).toBe("Ripley");
    expect(context.activeHost).toBe("proxBig");
  });
});
