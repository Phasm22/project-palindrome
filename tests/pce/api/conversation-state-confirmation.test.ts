import { test, expect, afterEach } from "bun:test";
import { ChatHistoryStore } from "../../../src/pce/api/chat-history-store";
import { rmSync } from "node:fs";

const tempPaths: string[] = [];

afterEach(() => {
  while (tempPaths.length) {
    const path = tempPaths.pop();
    if (path) {
      try {
        rmSync(path, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
});

test("conversation context persists strict confirmation envelope fields", async () => {
  const dbPath = `/tmp/chat-history-confirmation-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  tempPaths.push(dbPath);
  const store = new ChatHistoryStore(dbPath);
  const conversationId = await store.createConversation("dashboard-user");

  const ok = await store.setConversationContext(
    conversationId,
    {
      pendingAction: "make a vm called apple on yin",
      pendingActionId: "deadbeef",
      pendingActionCreatedAt: Date.now(),
      pendingActionSummary: "create vm apple on yin",
      pendingActionType: "intent:action",
      pendingActionPreview: "create vm apple on yin",
      pendingActionExecuteInput: "make a vm called apple on yin",
      pendingActionExpiresAt: Date.now() + 15 * 60 * 1000,
    },
    "policy_inference",
    0.9,
    "dashboard-user"
  );

  expect(ok).toBeTrue();

  const ctx = await store.getConversationContext(conversationId);
  expect(ctx.pendingActionId).toBe("deadbeef");
  expect(ctx.pendingActionPreview).toBe("create vm apple on yin");
  expect(ctx.pendingActionExecuteInput).toBe("make a vm called apple on yin");
  expect(typeof ctx.pendingActionExpiresAt).toBe("number");
});
