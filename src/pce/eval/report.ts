import { promises as fs } from "fs";
import { join, dirname } from "path";
import type { Finding } from "./checks";
import type { JudgeVerdict } from "./judge";

export interface EvalRunResult {
  ranAt: Date;
  traceCount: number;
  findings: Finding[];
  judgeVerdicts?: Array<{ traceId: string; verdict: JudgeVerdict }>;
}

export interface EvalSnapshotEntry {
  ranAt: string;
  traceCount: number;
  flaggedCount: number;
  findingsByType: Record<string, number>;
  judgeVerdictCounts?: Record<string, number>;
  findings: Finding[];
}

const DEFAULT_SNAPSHOT_PATH = ".pce-eval/snapshots.json";

function toSnapshotEntry(result: EvalRunResult): EvalSnapshotEntry {
  const findingsByType: Record<string, number> = {};
  for (const finding of result.findings) {
    findingsByType[finding.type] = (findingsByType[finding.type] ?? 0) + 1;
  }

  let judgeVerdictCounts: Record<string, number> | undefined;
  if (result.judgeVerdicts && result.judgeVerdicts.length > 0) {
    judgeVerdictCounts = {};
    for (const { verdict } of result.judgeVerdicts) {
      judgeVerdictCounts[verdict.verdict] = (judgeVerdictCounts[verdict.verdict] ?? 0) + 1;
    }
  }

  return {
    ranAt: result.ranAt.toISOString(),
    traceCount: result.traceCount,
    flaggedCount: result.findings.length,
    findingsByType,
    judgeVerdictCounts,
    findings: result.findings,
  };
}

/** Appends one entry per eval run to a JSON array log (same shape/spirit as the
 * .pce-dod-test snapshot-log precedent: append-only, timestamped, human-reviewable). */
export async function writeEvalSnapshot(
  result: EvalRunResult,
  path: string = DEFAULT_SNAPSHOT_PATH
): Promise<void> {
  await fs.mkdir(dirname(join(process.cwd(), path)), { recursive: true });

  let existing: EvalSnapshotEntry[] = [];
  try {
    const data = await fs.readFile(path, "utf-8");
    existing = JSON.parse(data);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }

  existing.push(toSnapshotEntry(result));
  await fs.writeFile(path, JSON.stringify(existing, null, 2), "utf-8");
}

export function printConsoleSummary(result: EvalRunResult): void {
  const entry = toSnapshotEntry(result);
  console.log(`\n=== Correctness eval: ${entry.traceCount} traces, ${entry.flaggedCount} flagged ===`);

  if (entry.flaggedCount === 0) {
    console.log("No findings.");
  } else {
    for (const [type, count] of Object.entries(entry.findingsByType)) {
      console.log(`  ${type}: ${count}`);
    }
    console.log("");
    for (const finding of result.findings) {
      console.log(`- [${finding.type}] ${finding.summary}`);
      console.log(`  traces: ${finding.traceIds.join(", ")}`);
    }
  }

  if (entry.judgeVerdictCounts) {
    console.log(`\n--- Judge verdicts ---`);
    for (const [verdict, count] of Object.entries(entry.judgeVerdictCounts)) {
      console.log(`  ${verdict}: ${count}`);
    }
  }
  console.log("");
}
