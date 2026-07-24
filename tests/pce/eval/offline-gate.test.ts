import { describe, expect, test } from "bun:test";
import { resolve } from "path";
import {
  assertEvalGate,
  evaluateEvalGate,
  formatEvalGateSummary,
  loadEvalGateSnapshot,
} from "../../../src/pce/eval/gate";

const FIXTURES_DIR = resolve(import.meta.dir, "fixtures");

describe("offline PCE eval gate", () => {
  test("passes the committed trace snapshot at its locked baseline", async () => {
    const snapshot = await loadEvalGateSnapshot(
      resolve(FIXTURES_DIR, "offline-eval.snapshot.json")
    );
    const result = evaluateEvalGate(snapshot.traces, snapshot.baseline);

    expect(result).toMatchObject({
      traceCount: 6,
      passCount: 5,
      flaggedTraceCount: 1,
      flaggedCount: 1,
      passed: true,
      failures: [],
    });
    expect(result.passRate).toBeCloseTo(5 / 6);
    expect(formatEvalGateSummary(result)).toContain("PASS: 5/6");
    expect(() => assertEvalGate(result)).not.toThrow();
  });

  test("fails a deliberately regressed fixture", async () => {
    const snapshot = await loadEvalGateSnapshot(
      resolve(FIXTURES_DIR, "regressed-eval.snapshot.json")
    );
    const result = evaluateEvalGate(snapshot.traces, snapshot.baseline);

    expect(result).toMatchObject({
      traceCount: 2,
      passCount: 0,
      flaggedTraceCount: 2,
      flaggedCount: 2,
      passed: false,
    });
    expect(result.failures).toEqual([
      "pass rate 0.00% is below baseline 83.00%",
      "flaggedCount 2 exceeds baseline 1",
    ]);
    expect(formatEvalGateSummary(result)).toContain("FAIL: 0/2");
    expect(() => assertEvalGate(result)).toThrow("PCE eval gate failed");
  });

  test("does not allow an empty trace set to pass vacuously", () => {
    const result = evaluateEvalGate([], {
      minPassRate: 0,
      maxFlaggedCount: 0,
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(["eval snapshot contains no traces"]);
  });
});
