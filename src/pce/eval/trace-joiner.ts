import type { ReasoningTrace, ReasoningStep } from "../api/reasoning-trace-store";
import type { ToolExecutionStore, ToolExecution } from "../api/tool-execution-store";

export type JoinConfidence = "exact" | "fuzzy" | "none";

export type JoinedToolCall = ReasoningStep["toolCalls"][number] & {
  /** Full untruncated tool result, when found — dataPreview on the trace itself is capped at 500 chars. */
  fullResult?: ToolExecution["result"];
  joinConfidence: JoinConfidence;
};

export type JoinedStep = Omit<ReasoningStep, "toolCalls"> & {
  toolCalls: JoinedToolCall[];
};

export type JoinedTrace = Omit<ReasoningTrace, "steps"> & {
  steps: JoinedStep[];
};

/** How far around a trace's own [timestamp - durationMs, timestamp] window to search for older
 * rows recorded before traceId threading existed (no exact traceId to join on). */
const FUZZY_WINDOW_PADDING_MS = 5_000;

/**
 * Joins a reasoning trace's (dataPreview-truncated) tool calls with their full,
 * untruncated data from ToolExecutionStore. Prefers an exact match via
 * trace_id (present on every tool_executions row recorded after traceId
 * threading shipped); falls back to fuzzy matching on toolName + userId +
 * timestamp proximity for older rows, consumed in call order.
 */
export async function joinTraceWithToolExecutions(
  trace: ReasoningTrace,
  executionStore: ToolExecutionStore
): Promise<JoinedTrace> {
  const { executions: exactMatches } = await executionStore.getExecutions({
    traceId: trace.id,
    limit: 1000,
  });

  let fuzzyPool: ToolExecution[] = [];
  if (exactMatches.length === 0) {
    const windowStart = new Date(trace.timestamp.getTime() - trace.durationMs - FUZZY_WINDOW_PADDING_MS);
    const { executions } = await executionStore.getExecutions({
      userId: trace.userId,
      since: windowStart,
      limit: 1000,
    });
    const windowEndMs = trace.timestamp.getTime() + FUZZY_WINDOW_PADDING_MS;
    fuzzyPool = executions
      .filter((e) => e.timestamp.getTime() <= windowEndMs)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  // Exact matches don't carry step order info from the DB row alone, but
  // there's rarely more than one call per toolName per trace; consume in
  // insertion order same as the fuzzy pool for consistency.
  const exactQueueByTool = new Map<string, ToolExecution[]>();
  for (const exec of exactMatches) {
    const list = exactQueueByTool.get(exec.toolName) ?? [];
    list.push(exec);
    exactQueueByTool.set(exec.toolName, list);
  }

  const fuzzyQueueByTool = new Map<string, ToolExecution[]>();
  for (const exec of fuzzyPool) {
    const list = fuzzyQueueByTool.get(exec.toolName) ?? [];
    list.push(exec);
    fuzzyQueueByTool.set(exec.toolName, list);
  }

  const steps: JoinedStep[] = trace.steps.map((step) => ({
    ...step,
    toolCalls: step.toolCalls.map((call): JoinedToolCall => {
      const exactList = exactQueueByTool.get(call.toolName);
      if (exactList && exactList.length > 0) {
        const match = exactList.shift()!;
        return { ...call, fullResult: match.result, joinConfidence: "exact" };
      }

      const fuzzyList = fuzzyQueueByTool.get(call.toolName);
      if (fuzzyList && fuzzyList.length > 0) {
        const match = fuzzyList.shift()!;
        return { ...call, fullResult: match.result, joinConfidence: "fuzzy" };
      }

      return { ...call, joinConfidence: "none" };
    }),
  }));

  return { ...trace, steps };
}
