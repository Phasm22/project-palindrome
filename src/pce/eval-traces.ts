#!/usr/bin/env bun
/**
 * Correctness-evaluation harness: pulls the last N real reasoning traces and
 * flags wrong-looking answers — tool failures paired with substantive-looking
 * data, and near-duplicate queries with contradictory answers. Optionally
 * runs an LLM-judge pass comparing each answer's claims against the full
 * tool data it actually had (--judge, opt-in since it costs money).
 *
 * This is a reporting script, not a bun:test suite — grading real historical
 * LLM output has no fixed expected value, unlike the deterministic
 * response-renderer fuzz tests. See src/pce/eval/checks.ts for the
 * deterministic, unit-tested parts of this pipeline.
 */
import { getReasoningTraceStore } from "./api/reasoning-trace-store";
import { getToolExecutionStore } from "./api/tool-execution-store";
import { joinTraceWithToolExecutions } from "./eval/trace-joiner";
import { checkFailedButSubstantiveAnswer, checkNearDuplicateConsistency } from "./eval/checks";
import { judgeTraceFactuality } from "./eval/judge";
import { writeEvalSnapshot, printConsoleSummary, type EvalRunResult } from "./eval/report";
import { pceLogger } from "./utils/logger";

interface CliArgs {
  limit: number;
  since?: Date;
  userId?: string;
  aclGroup?: string;
  judge: boolean;
  judgeModel: string;
  dnsOnly: boolean;
  snapshotPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { limit: 100, judge: false, judgeModel: "gpt-4o-mini", dnsOnly: false };
  for (const arg of argv) {
    const [rawKey, rawValue] = arg.replace(/^--/, "").split("=");
    const key = rawKey;
    switch (key) {
      case "limit":
        args.limit = Number(rawValue) || args.limit;
        break;
      case "since":
        args.since = rawValue ? new Date(rawValue) : undefined;
        break;
      case "user-id":
        args.userId = rawValue;
        break;
      case "acl-group":
        args.aclGroup = rawValue;
        break;
      case "judge":
        args.judge = true;
        break;
      case "judge-model":
        args.judgeModel = rawValue || args.judgeModel;
        break;
      case "dns-only":
        args.dnsOnly = true;
        break;
      case "snapshot-path":
        args.snapshotPath = rawValue;
        break;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const traceStore = getReasoningTraceStore();
  const executionStore = getToolExecutionStore();

  const { traces } = await traceStore.getTraces({
    limit: args.limit,
    since: args.since,
    userId: args.userId,
    aclGroup: args.aclGroup,
  });

  const filtered = args.dnsOnly
    ? traces.filter((t) => t.steps.some((s) => s.toolCalls.some((c) => c.toolName === "pihole_readonly")))
    : traces;

  pceLogger.info(`Evaluating ${filtered.length} trace(s)`, { requested: args.limit, dnsOnly: args.dnsOnly });

  const findings = [];
  const judgeVerdicts: EvalRunResult["judgeVerdicts"] = [];

  for (const trace of filtered) {
    const joined = await joinTraceWithToolExecutions(trace, executionStore);

    const failedButSubstantive = checkFailedButSubstantiveAnswer(joined);
    if (failedButSubstantive) findings.push(failedButSubstantive);

    if (args.judge) {
      try {
        const verdict = await judgeTraceFactuality(joined, args.judgeModel);
        judgeVerdicts.push({ traceId: trace.id, verdict });
        if (verdict.verdict === "unsupported" || verdict.verdict === "partially_supported") {
          findings.push({
            type: "failed_but_substantive_answer" as const,
            traceIds: [trace.id],
            summary: `Judge (${args.judgeModel}) rated this answer '${verdict.verdict}'.`,
            detail: { userInput: trace.userInput, claims: verdict.claims, notes: verdict.notes },
          });
        }
      } catch (error: any) {
        pceLogger.warn("Judge call failed for trace", { traceId: trace.id, error: error.message });
      }
    }
  }

  findings.push(...checkNearDuplicateConsistency(filtered));

  const result: EvalRunResult = {
    ranAt: new Date(),
    traceCount: filtered.length,
    findings,
    judgeVerdicts: judgeVerdicts.length > 0 ? judgeVerdicts : undefined,
  };

  printConsoleSummary(result);
  await writeEvalSnapshot(result, args.snapshotPath);
}

main().catch((error) => {
  pceLogger.error("eval-traces failed", { error: error.message });
  process.exit(1);
});
