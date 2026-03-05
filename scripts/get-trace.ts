#!/usr/bin/env bun
/**
 * Fetch a reasoning trace by ID and print it (for diagnostics).
 * Usage: bun run scripts/get-trace.ts <trace-id>
 */
import { getReasoningTraceStore } from "../src/pce/api/reasoning-trace-store";

const id = process.argv[2];
if (!id) {
  console.error("Usage: bun run scripts/get-trace.ts <trace-id>");
  process.exit(1);
}

const store = getReasoningTraceStore();
const trace = await store.getTrace(id, { includeArtifacts: true });
if (!trace) {
  console.error("Trace not found:", id);
  process.exit(1);
}

console.log(JSON.stringify(trace, null, 2));
