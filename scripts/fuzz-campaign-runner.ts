/**
 * Fuzz-campaign harness (not a Vitest/Bun test — a live-API driver).
 *
 * Reads a JSON corpus (see docs/tests/fuzz-corpus-2026-07-21.json for the shape),
 * drives the live agent API (POST /api/agent/query + SSE /api/agent/stream), and
 * appends one JSON result per line to the output file. Requires the palindrome
 * stack to be up (`pc-stacks up palindrome`).
 *
 * Usage:
 *   bun run scripts/fuzz-campaign-runner.ts <outPath> <concurrency> [onlyCategoryOrIdPrefix]
 *   FUZZ_CORPUS_PATH=path/to/corpus.json bun run scripts/fuzz-campaign-runner.ts ...
 */

const BASE = "http://localhost:4000";
const CORPUS_PATH = process.env.FUZZ_CORPUS_PATH || "docs/tests/fuzz-corpus-2026-07-21.json";
const OUT_PATH = process.argv[2] || "docs/tests/fuzz-results-2026-07-21.jsonl";
const CONCURRENCY = Number(process.argv[3] || 5);
const ONLY_CATEGORY = process.argv[4] || null; // optional filter
const PER_QUERY_TIMEOUT_MS = 90_000;

type Job = {
  id: string;
  category: string;
  query: string;
  meta?: Record<string, unknown>;
};

type MultiTurnFlow = {
  id: string;
  category: string;
  description?: string;
  turns: { input: string }[];
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readSSEUntilFinal(
  sessionId: string,
  timeoutMs: number
): Promise<{ events: any[]; finalEvent: any | null; timedOut: boolean }> {
  const events: any[] = [];
  let finalEvent: any | null = null;
  let timedOut = false;

  const resp = await fetch(`${BASE}/api/agent/stream?sessionId=${encodeURIComponent(sessionId)}`);
  if (!resp.body) {
    return { events, finalEvent, timedOut: true };
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        sleep(remaining).then(() => ({ done: false, value: undefined, __timeout: true } as any)),
      ]);
      if ((result as any).__timeout) {
        timedOut = true;
        break;
      }
      const { done, value } = result as any;
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = chunk.split("\n").filter((l) => l.startsWith("data: "));
        for (const line of lines) {
          const jsonStr = line.slice(6);
          try {
            const evt = JSON.parse(jsonStr);
            events.push(evt);
            if (evt.type === "agent:final") {
              finalEvent = evt;
            }
          } catch {
            // ignore malformed SSE data lines
          }
        }
      }
      if (finalEvent) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }

  return { events, finalEvent, timedOut: timedOut && !finalEvent };
}

async function fetchTrace(traceId: string): Promise<any | null> {
  try {
    const resp = await fetch(`${BASE}/api/dashboard/reasoning-traces/${encodeURIComponent(traceId)}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function runSingleQuery(
  job: Job,
  userId: string,
  sessionIdOverride?: string,
  conversationIdOverride?: string
): Promise<Record<string, unknown>> {
  const sessionId = sessionIdOverride || `fuzz-${job.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const startedAt = Date.now();

  // Connect to the SSE stream first so we don't miss fast events.
  const ssePromise = readSSEUntilFinal(sessionId, PER_QUERY_TIMEOUT_MS);
  await sleep(200);

  let postStatus = 0;
  let postJson: any = null;
  let postError: string | null = null;
  try {
    const postResp = await fetch(`${BASE}/api/agent/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: job.query,
        sessionId,
        userId,
        aclGroup: "admin",
        // POST /api/agent/query creates a brand-new, context-free
        // conversation whenever conversationId is omitted — reusing
        // sessionId alone across turns is NOT the persistence key (see
        // fuzz-campaign-2026-07-21.md's G-08 finding, root-caused to this
        // exact gap: this harness previously never forwarded it, so every
        // "multi-turn" flow was actually N independent, contextless
        // conversations, matching neither the real dashboard client's
        // behavior nor the server's actual persistence contract).
        ...(conversationIdOverride ? { conversationId: conversationIdOverride } : {}),
      }),
    });
    postStatus = postResp.status;
    postJson = await postResp.json().catch(() => null);
  } catch (err: any) {
    postError = err?.message || String(err);
  }

  const { events, finalEvent, timedOut } = await ssePromise;
  const latencyMs = Date.now() - startedAt;

  let trace: any = null;
  const traceId = finalEvent?.data?.traceId;
  if (traceId) {
    trace = await fetchTrace(traceId);
  }

  return {
    id: job.id,
    category: job.category,
    query: job.query,
    meta: job.meta || {},
    sessionId,
    userId,
    postStatus,
    postError,
    postJson,
    latencyMs,
    timedOut,
    eventCount: events.length,
    eventTypes: events.map((e) => e.type),
    finalEvent: finalEvent?.data || null,
    trace,
    capturedAt: new Date().toISOString(),
  };
}

async function runMultiTurnFlow(flow: MultiTurnFlow, userId: string): Promise<Record<string, unknown>> {
  const sessionId = `fuzz-${flow.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const turnResults: Record<string, unknown>[] = [];
  // conversationId (not sessionId) is the server's actual persistence key —
  // thread the one returned by each turn's response into the next turn's
  // request so the flow is a genuine multi-turn conversation. Without this,
  // every turn silently starts a brand-new, context-free conversation.
  let conversationId: string | undefined;
  for (let i = 0; i < flow.turns.length; i++) {
    const turn = flow.turns[i];
    const job: Job = { id: `${flow.id}-turn${i + 1}`, category: flow.category, query: turn.input };
    const result = await runSingleQuery(job, userId, sessionId, conversationId);
    turnResults.push(result);
    const postJson = result.postJson as { conversationId?: string } | null;
    conversationId = postJson?.conversationId || conversationId;
  }
  return {
    id: flow.id,
    category: flow.category,
    description: flow.description,
    sessionId,
    userId,
    turns: turnResults,
    capturedAt: new Date().toISOString(),
  };
}

function appendResult(outFile: string, obj: unknown) {
  const line = JSON.stringify(obj) + "\n";
  require("fs").appendFileSync(outFile, line);
}

async function pool<T>(items: T[], concurrency: number, worker: (item: T, workerIdx: number) => Promise<void>) {
  let idx = 0;
  const workers = Array.from({ length: concurrency }, (_, workerIdx) =>
    (async () => {
      while (true) {
        const myIdx = idx++;
        if (myIdx >= items.length) break;
        await worker(items[myIdx], workerIdx);
      }
    })()
  );
  await Promise.all(workers);
}

async function main() {
  const corpusRaw = await Bun.file(CORPUS_PATH).text();
  const corpus = JSON.parse(corpusRaw);

  const singleTurnCategories = [
    "singleTurn",
    "knownFailureRegression",
    "visionGapProbes",
    "entityEdgeCases",
    "formatStress",
    "compositeQueries",
    "adversarial",
  ];

  let jobs: Job[] = [];
  for (const key of singleTurnCategories) {
    const arr = corpus[key] as Job[] | undefined;
    if (!arr) continue;
    for (const item of arr) {
      jobs.push(item);
    }
  }
  if (ONLY_CATEGORY) {
    jobs = jobs.filter((j) => j.category === ONLY_CATEGORY || j.id.startsWith(ONLY_CATEGORY));
  }

  console.log(`Loaded ${jobs.length} single-turn jobs.`);

  let completed = 0;
  await pool(jobs, CONCURRENCY, async (job, workerIdx) => {
    const userId = `fuzz-user-${workerIdx + 1}`;
    const t0 = Date.now();
    try {
      const result = await runSingleQuery(job, userId);
      appendResult(OUT_PATH, { kind: "singleTurn", ...result });
      completed++;
      console.log(
        `[${completed}/${jobs.length}] ${job.id} (${job.category}) status=${result.postStatus} latency=${Date.now() - t0}ms timedOut=${result.timedOut}`
      );
    } catch (err: any) {
      completed++;
      console.error(`[${completed}/${jobs.length}] ${job.id} FAILED: ${err?.message || err}`);
      appendResult(OUT_PATH, { kind: "singleTurn", id: job.id, category: job.category, query: job.query, error: err?.message || String(err) });
    }
  });

  if (!ONLY_CATEGORY || ONLY_CATEGORY === "multiTurn") {
    const flows = (corpus.multiTurn as MultiTurnFlow[]) || [];
    console.log(`Loaded ${flows.length} multi-turn flows.`);
    let flowsCompleted = 0;
    await pool(flows, Math.min(CONCURRENCY, 4), async (flow, workerIdx) => {
      const userId = `fuzz-flow-user-${workerIdx + 1}`;
      const t0 = Date.now();
      try {
        const result = await runMultiTurnFlow(flow, userId);
        appendResult(OUT_PATH, { kind: "multiTurn", ...result });
        flowsCompleted++;
        console.log(`[flow ${flowsCompleted}/${flows.length}] ${flow.id} completed in ${Date.now() - t0}ms`);
      } catch (err: any) {
        flowsCompleted++;
        console.error(`[flow ${flowsCompleted}/${flows.length}] ${flow.id} FAILED: ${err?.message || err}`);
        appendResult(OUT_PATH, { kind: "multiTurn", id: flow.id, category: flow.category, error: err?.message || String(err) });
      }
    });
  }

  console.log("Fuzz run complete.");
}

main().catch((err) => {
  console.error("Fatal error in fuzz runner:", err);
  process.exit(1);
});
