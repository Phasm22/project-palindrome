import { describe, test, expect } from "bun:test";
import { checkFailedButSubstantiveAnswer, checkNearDuplicateConsistency } from "../../../src/pce/eval/checks";
import type { JoinedTrace } from "../../../src/pce/eval/trace-joiner";
import type { ReasoningTrace } from "../../../src/pce/api/reasoning-trace-store";

function makeJoinedTrace(overrides: Partial<JoinedTrace> = {}): JoinedTrace {
  return {
    id: "trace-1",
    userId: "tj",
    aclGroup: "admin",
    userInput: "is homebridge running",
    finalResponse: "homebridge is running on YANG",
    steps: [],
    totalSteps: 1,
    totalToolCalls: 1,
    maxStepsReached: false,
    timestamp: new Date(),
    durationMs: 500,
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ReasoningTrace> = {}): ReasoningTrace {
  return {
    id: "trace-1",
    userId: "tj",
    aclGroup: "admin",
    userInput: "is homebridge running",
    finalResponse: "homebridge is running on YANG",
    steps: [],
    totalSteps: 1,
    totalToolCalls: 1,
    maxStepsReached: false,
    timestamp: new Date(),
    durationMs: 500,
    ...overrides,
  };
}

describe("checkFailedButSubstantiveAnswer", () => {
  test("flags a failed tool call paired with a substantive-looking final answer", () => {
    const joined = makeJoinedTrace({
      finalResponse: "The node is at 172.16.0.13 and reports 42 active connections right now.",
      steps: [
        {
          step: 1,
          toolCalls: [
            { toolName: "pihole_readonly", parameters: {}, result: { success: false, error: "timeout" }, joinConfidence: "exact" },
          ],
          decisions: [],
        },
      ],
    });

    const finding = checkFailedButSubstantiveAnswer(joined);
    expect(finding).not.toBeNull();
    expect(finding?.type).toBe("failed_but_substantive_answer");
  });

  test("does not flag when the tool call succeeded", () => {
    const joined = makeJoinedTrace({
      steps: [
        {
          step: 1,
          toolCalls: [
            { toolName: "pihole_readonly", parameters: {}, result: { success: true }, joinConfidence: "exact" },
          ],
          decisions: [],
        },
      ],
    });

    expect(checkFailedButSubstantiveAnswer(joined)).toBeNull();
  });

  test("does not flag when the failed call is paired with an honest apology, not fabricated data", () => {
    const joined = makeJoinedTrace({
      finalResponse: "I couldn't retrieve that information right now — the tool call failed.",
      steps: [
        {
          step: 1,
          toolCalls: [
            { toolName: "pihole_readonly", parameters: {}, result: { success: false, error: "timeout" }, joinConfidence: "exact" },
          ],
          decisions: [],
        },
      ],
    });

    expect(checkFailedButSubstantiveAnswer(joined)).toBeNull();
  });

  test("does not flag when there's no final response at all", () => {
    const joined = makeJoinedTrace({
      finalResponse: undefined,
      steps: [
        {
          step: 1,
          toolCalls: [
            { toolName: "pihole_readonly", parameters: {}, result: { success: false, error: "timeout" }, joinConfidence: "exact" },
          ],
          decisions: [],
        },
      ],
    });

    expect(checkFailedButSubstantiveAnswer(joined)).toBeNull();
  });
});

describe("checkNearDuplicateConsistency", () => {
  test("flags near-identical queries whose answers contradict each other", () => {
    const traces = [
      makeTrace({ id: "t1", userInput: "is homebridge running", finalResponse: "homebridge is running on YANG" }),
      makeTrace({ id: "t2", userInput: "is homebridge running right now", finalResponse: "homebridge is stopped" }),
    ];

    const findings = checkNearDuplicateConsistency(traces);
    expect(findings.length).toBe(1);
    expect(findings[0]!.type).toBe("near_duplicate_inconsistency");
    expect(findings[0]!.traceIds.sort()).toEqual(["t1", "t2"]);
  });

  test("does not flag near-identical queries that agree", () => {
    const traces = [
      makeTrace({ id: "t1", userInput: "is homebridge running", finalResponse: "homebridge is running on YANG" }),
      makeTrace({ id: "t2", userInput: "is homebridge running right now", finalResponse: "yes, homebridge is running" }),
    ];

    expect(checkNearDuplicateConsistency(traces)).toEqual([]);
  });

  test("does not group unrelated queries", () => {
    const traces = [
      makeTrace({ id: "t1", userInput: "is homebridge running", finalResponse: "homebridge is running" }),
      makeTrace({ id: "t2", userInput: "what are the top blocked domains today", finalResponse: "mask.icloud.com is blocked" }),
    ];

    expect(checkNearDuplicateConsistency(traces)).toEqual([]);
  });

  test("handles a single trace (no group) without error", () => {
    const traces = [makeTrace({ id: "t1" })];
    expect(checkNearDuplicateConsistency(traces)).toEqual([]);
  });

  test("handles an empty trace list without error", () => {
    expect(checkNearDuplicateConsistency([])).toEqual([]);
  });
});
