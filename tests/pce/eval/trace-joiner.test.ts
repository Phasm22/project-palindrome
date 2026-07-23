import { describe, test, expect, afterEach } from "bun:test";
import { ReasoningTraceStore } from "../../../src/pce/api/reasoning-trace-store";
import { ToolExecutionStore } from "../../../src/pce/api/tool-execution-store";
import { joinTraceWithToolExecutions } from "../../../src/pce/eval/trace-joiner";

describe("joinTraceWithToolExecutions", () => {
  let traceStore: ReasoningTraceStore;
  let executionStore: ToolExecutionStore;

  afterEach(() => {
    traceStore?.close();
    executionStore?.close();
  });

  test("exact match: joins via traceId and returns the full untruncated data, not the 500-char preview", async () => {
    traceStore = new ReasoningTraceStore(":memory:");
    executionStore = new ToolExecutionStore(":memory:");

    const fullData = { domains: Array.from({ length: 50 }, (_, i) => ({ domain: `d${i}.com`, count: i })) };
    const preview = JSON.stringify(fullData).slice(0, 60) + "...(truncated)";

    const traceId = await traceStore.recordTrace({
      userId: "tj",
      aclGroup: "admin",
      userInput: "top blocked domains",
      finalResponse: "here are the top domains",
      steps: [
        {
          step: 1,
          toolCalls: [
            {
              toolName: "pihole_readonly",
              parameters: { action: "dns_top_domains" },
              result: { success: true, dataPreview: preview, dataSize: 5000, resultType: "object" },
            },
          ],
          decisions: [],
        },
      ],
      totalSteps: 1,
      totalToolCalls: 1,
      maxStepsReached: false,
      timestamp: new Date(),
      durationMs: 1200,
    });

    await executionStore.recordExecution({
      toolName: "pihole_readonly",
      parameters: { action: "dns_top_domains" },
      result: { data: fullData },
      userId: "tj",
      aclGroup: "admin",
      durationMs: 1200,
      timestamp: new Date(),
      traceId,
    });

    const trace = await traceStore.getTrace(traceId);
    const joined = await joinTraceWithToolExecutions(trace!, executionStore);

    const call = joined.steps[0]!.toolCalls[0]!;
    expect(call.joinConfidence).toBe("exact");
    expect(call.fullResult?.data).toEqual(fullData);
    expect((call.fullResult?.data as any).domains.length).toBe(50);
  });

  test("fuzzy fallback: matches by toolName + userId + timestamp proximity when no traceId is present", async () => {
    traceStore = new ReasoningTraceStore(":memory:");
    executionStore = new ToolExecutionStore(":memory:");

    const now = new Date();
    const traceId = await traceStore.recordTrace({
      userId: "tj",
      aclGroup: "admin",
      userInput: "list dns records",
      finalResponse: "here they are",
      steps: [
        {
          step: 1,
          toolCalls: [
            { toolName: "pihole_readonly", parameters: {}, result: { success: true, dataPreview: "..." } },
          ],
          decisions: [],
        },
      ],
      totalSteps: 1,
      totalToolCalls: 1,
      maxStepsReached: false,
      timestamp: now,
      durationMs: 500,
    });

    // No traceId passed — simulates a row recorded before traceId threading existed.
    await executionStore.recordExecution({
      toolName: "pihole_readonly",
      parameters: {},
      result: { data: { records: [{ domain: "a.prox", ip: "172.16.0.1" }] } },
      userId: "tj",
      aclGroup: "admin",
      durationMs: 500,
      timestamp: now,
    });

    const trace = await traceStore.getTrace(traceId);
    const joined = await joinTraceWithToolExecutions(trace!, executionStore);

    const call = joined.steps[0]!.toolCalls[0]!;
    expect(call.joinConfidence).toBe("fuzzy");
    expect(call.fullResult?.data).toEqual({ records: [{ domain: "a.prox", ip: "172.16.0.1" }] });
  });

  test("no match: marks joinConfidence 'none' without throwing when nothing lines up", async () => {
    traceStore = new ReasoningTraceStore(":memory:");
    executionStore = new ToolExecutionStore(":memory:");

    const traceId = await traceStore.recordTrace({
      userId: "tj",
      aclGroup: "admin",
      userInput: "orphaned trace",
      finalResponse: "answer",
      steps: [
        { step: 1, toolCalls: [{ toolName: "twin_query", parameters: {}, result: { success: true } }], decisions: [] },
      ],
      totalSteps: 1,
      totalToolCalls: 1,
      maxStepsReached: false,
      timestamp: new Date(),
      durationMs: 100,
    });

    const trace = await traceStore.getTrace(traceId);
    const joined = await joinTraceWithToolExecutions(trace!, executionStore);

    expect(joined.steps[0]!.toolCalls[0]!.joinConfidence).toBe("none");
    expect(joined.steps[0]!.toolCalls[0]!.fullResult).toBeUndefined();
  });
});
