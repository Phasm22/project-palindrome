#!/usr/bin/env bun
/**
 * Opt-in live replay for the PCE eval gate.
 *
 * Default execution is deliberately a no-op. Set PCE_LIVE_EVAL=1 only when a
 * populated Palindrome stack is available at http://localhost:4000. The script
 * replays the committed fuzz corpus through the existing live campaign runner,
 * then applies the same deterministic heuristics used by the offline CI gate.
 *
 * This is a heuristic regression gate, not a replacement for the campaign's
 * human grading against Neo4j ground truth.
 */
import { mkdir, readFile } from "fs/promises";
import { dirname, resolve } from "path";
import {
  assertEvalGate,
  evaluateEvalGate,
  formatEvalGateSummary,
  hydrateEvalTrace,
  type EvalGateBaseline,
} from "../src/pce/eval/gate";
import type { JoinedTrace } from "../src/pce/eval/trace-joiner";

const DEFAULT_CORPUS_PATH = "docs/tests/fuzz-corpus-2026-07-21.json";
const HISTORICAL_LIVE_BASELINE: EvalGateBaseline = {
  minPassRate: 0.87,
  maxFlaggedCount: 7,
};

interface CapturedResult {
  kind?: string;
  id?: string;
  error?: string;
  postStatus?: number;
  postError?: string | null;
  timedOut?: boolean;
  finalEvent?: unknown;
  trace?: unknown;
  turns?: CapturedResult[];
}

function readNumberEnv(
  name: string,
  fallback: number,
  options: { min: number; max: number; integer?: boolean }
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  const valid =
    Number.isFinite(value) &&
    value >= options.min &&
    value <= options.max &&
    (!options.integer || Number.isInteger(value));
  if (!valid) {
    throw new Error(
      `${name} must be ${options.integer ? "an integer" : "a number"} between ${options.min} and ${options.max}`
    );
  }
  return value;
}

function flattenCapturedResults(results: CapturedResult[]): CapturedResult[] {
  return results.flatMap((result) =>
    result.kind === "multiTurn" ? result.turns ?? [] : [result]
  );
}

async function readCapturedResults(path: string): Promise<CapturedResult[]> {
  const lines = (await readFile(path, "utf-8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as CapturedResult;
    } catch (error) {
      throw new Error(`invalid JSONL at ${path}:${index + 1}: ${(error as Error).message}`);
    }
  });
}

function collectTraces(results: CapturedResult[]): {
  traces: JoinedTrace[];
  captureFailures: string[];
} {
  const traces: JoinedTrace[] = [];
  const captureFailures: string[] = [];

  for (const result of flattenCapturedResults(results)) {
    const id = result.id ?? "(unknown case)";
    const issues: string[] = [];
    if (result.error) issues.push(`runner error: ${result.error}`);
    if (result.postError) issues.push(`request error: ${result.postError}`);
    if (result.postStatus !== undefined && result.postStatus !== 200) {
      issues.push(`HTTP ${result.postStatus}`);
    }
    if (result.timedOut) issues.push("timed out");
    if (!result.finalEvent) issues.push("no final event");

    if (result.trace) {
      try {
        traces.push(hydrateEvalTrace(result.trace));
      } catch (error) {
        issues.push(`invalid captured trace: ${(error as Error).message}`);
      }
    }
    if (issues.length > 0) captureFailures.push(`${id}: ${issues.join(", ")}`);
  }

  return { traces, captureFailures };
}

function liveOutputPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(process.env.PCE_EVAL_RESULTS_PATH ?? `.pce-eval/live-fuzz-${timestamp}.jsonl`);
}

async function main(): Promise<void> {
  if (process.env.PCE_LIVE_EVAL !== "1") {
    console.log(
      "SKIP: live PCE eval is opt-in. Set PCE_LIVE_EVAL=1 only with a populated live stack."
    );
    return;
  }

  const corpusPath = resolve(process.env.PCE_EVAL_CORPUS_PATH ?? DEFAULT_CORPUS_PATH);
  const outputPath = liveOutputPath();
  const concurrency = readNumberEnv("PCE_EVAL_CONCURRENCY", 5, {
    min: 1,
    max: 20,
    integer: true,
  });
  const baseline: EvalGateBaseline = {
    minPassRate: readNumberEnv(
      "PCE_EVAL_MIN_PASS_RATE",
      HISTORICAL_LIVE_BASELINE.minPassRate,
      { min: 0, max: 1 }
    ),
    maxFlaggedCount: readNumberEnv(
      "PCE_EVAL_MAX_FLAGGED_COUNT",
      HISTORICAL_LIVE_BASELINE.maxFlaggedCount,
      { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true }
    ),
  };
  const maxCaptureFailures = readNumberEnv("PCE_EVAL_MAX_CAPTURE_FAILURES", 1, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    integer: true,
  });

  await mkdir(dirname(outputPath), { recursive: true });
  console.log(`LIVE EVAL: replaying ${corpusPath}`);
  console.log(`LIVE EVAL: raw results will be written to ${outputPath}`);

  const command = [
    "bun",
    "run",
    "scripts/fuzz-campaign-runner.ts",
    outputPath,
    String(concurrency),
  ];
  if (process.env.PCE_EVAL_ONLY) command.push(process.env.PCE_EVAL_ONLY);

  const replay = Bun.spawn(command, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FUZZ_CORPUS_PATH: corpusPath,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const replayExitCode = await replay.exited;
  if (replayExitCode !== 0) {
    throw new Error(`live fuzz replay exited with status ${replayExitCode}`);
  }

  const captured = await readCapturedResults(outputPath);
  const { traces, captureFailures } = collectTraces(captured);
  if (captureFailures.length > maxCaptureFailures) {
    throw new Error(
      `live replay had ${captureFailures.length} capture failure(s), exceeding baseline ${maxCaptureFailures}:\n${captureFailures.join("\n")}`
    );
  }
  if (captureFailures.length > 0) {
    console.warn(
      `LIVE EVAL: ${captureFailures.length} capture failure(s) retained within baseline ${maxCaptureFailures}:\n${captureFailures.join("\n")}`
    );
  }

  const result = evaluateEvalGate(traces, baseline);
  console.log(formatEvalGateSummary(result));
  for (const finding of result.findings) {
    console.log(`- [${finding.type}] ${finding.traceIds.join(", ")}: ${finding.summary}`);
  }
  assertEvalGate(result);
  console.log(
    "LIVE EVAL NOTE: heuristic gate passed; retain human/ground-truth grading for semantic correctness."
  );
}

main().catch((error) => {
  console.error(`PCE live eval failed: ${(error as Error).message}`);
  process.exit(1);
});
