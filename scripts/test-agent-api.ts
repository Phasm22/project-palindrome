#!/usr/bin/env bun
/**
 * Test the agent via the PCE API (localhost) for session and context-based flows.
 *
 * Prerequisites: PCE API running (bun run pce:api).
 *
 * Usage:
 *   bun run scripts/test-agent-api.ts "your query"
 *   bun run scripts/test-agent-api.ts "follow-up query" <conversationId>
 *
 * With conversationId, the API loads conversation history/state and passes them to runAgent.
 * Uses polling of conversation messages (works in Bun); for SSE use curl or the dashboard.
 */

const API_BASE = process.env.PCE_API_URL || "http://localhost:4000";
const userId = process.env.PCE_USER_ID || "test-user";
const aclGroup = process.env.PCE_ACL_GROUP || "admin";

async function runQuery(
  query: string,
  conversationId?: string | null
): Promise<{ text: string; conversationId: string | null; sessionId: string }> {
  const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const body: Record<string, string> = {
    query,
    userId,
    aclGroup,
    sessionId,
  };
  if (conversationId) body.conversationId = conversationId;

  const res = await fetch(`${API_BASE}/api/agent/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }
  const data = (await res.json()) as {
    success?: boolean;
    sessionId?: string;
    conversationId?: string | null;
    message?: string;
  };
  const cid = data.conversationId ?? null;
  if (!cid) {
    throw new Error("API did not return conversationId (chat history store may be unavailable)");
  }
  const text = await pollForAssistantMessage(cid);
  return { text, conversationId: cid, sessionId: data.sessionId ?? sessionId };
}

/** Poll GET /api/chat/conversations/:id/messages until the latest message is from assistant (agent reply). */
async function pollForAssistantMessage(conversationId: string): Promise<string> {
  const url = `${API_BASE}/api/chat/conversations/${conversationId}/messages?userId=${encodeURIComponent(userId)}`;
  const deadline = Date.now() + 25_000;
  let lastAssistantContent = "";
  while (Date.now() < deadline) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Messages API error ${res.status}`);
    const json = (await res.json()) as { success?: boolean; data?: Array<{ role: string; content: string }> };
    const messages = json.data ?? [];
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") {
      return last.content;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("Timeout waiting for assistant reply (25s)");
}

async function main() {
  const args = process.argv.slice(2);
  const query = args[0];
  const conversationId = args[1] || null;
  if (!query) {
    console.error("Usage: bun run scripts/test-agent-api.ts \"your query\" [conversationId]");
    process.exit(1);
  }

  try {
    const { text, conversationId: cid } = await runQuery(query, conversationId);
    console.log(text);
    // Pass conversationId for follow-up: bun run scripts/test-agent-api.ts "follow-up?" "$(bun run scripts/test-agent-api.ts 'first' 2>&1 | sed -n 's/\[conversationId\] //p')"
    if (cid) console.error("[conversationId]", cid);
  } catch (e) {
    console.error("Error:", (e as Error).message);
    process.exit(1);
  }
}

main();
