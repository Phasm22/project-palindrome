import { readFile } from "fs/promises";
import { z } from "zod";
import type { ReasoningTrace } from "../api/reasoning-trace-store";
import { checkFailedButSubstantiveAnswer, checkNearDuplicateConsistency, type Finding } from "./checks";
import type { JoinedTrace, JoinConfidence } from "./trace-joiner";

export interface EvalGateBaseline {
  minPassRate: number;
  maxFlaggedCount: number;
}

export interface EvalGateSnapshot {
  schemaVersion: 1;
  name: string;
  description?: string;
  source?: Record<string, unknown>;
  baseline: EvalGateBaseline;
  traces: JoinedTrace[];
}

export interface EvalGateResult {
  traceCount: number;
  passCount: number;
  passRate: number;
  flaggedTraceCount: number;
  flaggedCount: number;
  findings: Finding[];
  baseline: EvalGateBaseline;
  passed: boolean;
  failures: string[];
}

const SerializedToolCallSchema = z.object({
  toolName: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  result: z.object({
    success: z.boolean(),
    error: z.string().optional(),
    dataPreview: z.string().optional(),
    dataSize: z.number().optional(),
    resultType: z.string().optional(),
  }).optional(),
  durationMs: z.number().optional(),
  fullResult: z.object({
    data: z.unknown().optional(),
    error: z.string().optional(),
  }).passthrough().optional(),
  joinConfidence: z.enum(["exact", "fuzzy", "none"]).optional(),
}).passthrough();

const SerializedTraceSchema = z.object({
  id: z.string().min(1),
  userId: z.string(),
  aclGroup: z.string(),
  userInput: z.string(),
  finalResponse: z.string().optional(),
  steps: z.array(z.object({
    step: z.number().int().nonnegative(),
    llmResponse: z.string().optional(),
    toolCalls: z.array(SerializedToolCallSchema),
    ragContextId: z.string().optional(),
    graphContextId: z.string().optional(),
    fusionContextId: z.string().optional(),
    decisions: z.array(z.unknown()),
  }).passthrough()),
  totalSteps: z.number().int().nonnegative(),
  totalToolCalls: z.number().int().nonnegative(),
  maxStepsReached: z.boolean(),
  timestamp: z.string().datetime(),
  durationMs: z.number().nonnegative(),
}).passthrough();

const EvalGateSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  description: z.string().optional(),
  source: z.record(z.string(), z.unknown()).optional(),
  baseline: z.object({
    minPassRate: z.number().min(0).max(1),
    maxFlaggedCount: z.number().int().nonnegative(),
  }),
  traces: z.array(SerializedTraceSchema),
});

type SerializedTrace = z.infer<typeof SerializedTraceSchema>;

function hydrateTrace(trace: SerializedTrace): JoinedTrace {
  return {
    ...trace,
    timestamp: new Date(trace.timestamp),
    steps: trace.steps.map((step) => ({
      ...step,
      decisions: step.decisions as ReasoningTrace["steps"][number]["decisions"],
      toolCalls: step.toolCalls.map((call) => ({
        ...call,
        joinConfidence: (call.joinConfidence ?? "none") as JoinConfidence,
      })),
    })),
  } as JoinedTrace;
}

export function hydrateEvalTrace(serialized: unknown): JoinedTrace {
  return hydrateTrace(SerializedTraceSchema.parse(serialized));
}

export async function loadEvalGateSnapshot(path: string): Promise<EvalGateSnapshot> {
  const serialized = JSON.parse(await readFile(path, "utf-8"));
  const parsed = EvalGateSnapshotSchema.parse(serialized);

  return {
    ...parsed,
    traces: parsed.traces.map(hydrateTrace),
  };
}

/**
 * Runs the deterministic trace heuristics and converts findings into a gate:
 * a trace passes only when no finding references its id. flaggedCount counts
 * findings, while flaggedTraceCount de-duplicates trace ids across findings.
 */
export function evaluateEvalGate(
  traces: JoinedTrace[],
  baseline: EvalGateBaseline
): EvalGateResult {
  const findings: Finding[] = [];

  for (const trace of traces) {
    const finding = checkFailedButSubstantiveAnswer(trace);
    if (finding) findings.push(finding);
  }
  findings.push(...checkNearDuplicateConsistency(traces));

  const knownTraceIds = new Set(traces.map((trace) => trace.id));
  const flaggedTraceIds = new Set(
    findings.flatMap((finding) => finding.traceIds).filter((traceId) => knownTraceIds.has(traceId))
  );
  const traceCount = traces.length;
  const passCount = traceCount - flaggedTraceIds.size;
  const passRate = traceCount === 0 ? 0 : passCount / traceCount;
  const failures: string[] = [];

  if (traceCount === 0) {
    failures.push("eval snapshot contains no traces");
  }
  if (passRate + Number.EPSILON < baseline.minPassRate) {
    failures.push(
      `pass rate ${(passRate * 100).toFixed(2)}% is below baseline ${(baseline.minPassRate * 100).toFixed(2)}%`
    );
  }
  if (findings.length > baseline.maxFlaggedCount) {
    failures.push(
      `flaggedCount ${findings.length} exceeds baseline ${baseline.maxFlaggedCount}`
    );
  }

  return {
    traceCount,
    passCount,
    passRate,
    flaggedTraceCount: flaggedTraceIds.size,
    flaggedCount: findings.length,
    findings,
    baseline,
    passed: failures.length === 0,
    failures,
  };
}

export function assertEvalGate(result: EvalGateResult): void {
  if (!result.passed) {
    throw new Error(`PCE eval gate failed: ${result.failures.join("; ")}`);
  }
}

export function formatEvalGateSummary(result: EvalGateResult): string {
  const status = result.passed ? "PASS" : "FAIL";
  return [
    `${status}: ${result.passCount}/${result.traceCount} traces passed (${(result.passRate * 100).toFixed(2)}%)`,
    `flaggedCount=${result.flaggedCount} (baseline <= ${result.baseline.maxFlaggedCount})`,
    `minPassRate=${(result.baseline.minPassRate * 100).toFixed(2)}%`,
  ].join("; ");
}
