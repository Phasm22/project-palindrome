import type { ReasoningTrace } from "../api/reasoning-trace-store";
import type { JoinedTrace } from "./trace-joiner";

export interface Finding {
  type: "failed_but_substantive_answer" | "near_duplicate_inconsistency";
  traceIds: string[];
  summary: string;
  detail?: Record<string, any>;
}

const APOLOGY_PHRASES = [
  "couldn't",
  "could not",
  "unable to",
  "not able to",
  "sorry",
  "failed to",
  "error occurred",
  "something went wrong",
  "please try again",
];

/** Crude "does this look like it's presenting real data" signal — numbers, IPs, or domain-like tokens. */
function looksSubstantive(text: string): boolean {
  if (text.trim().length < 40) return false;
  const lower = text.toLowerCase();
  if (APOLOGY_PHRASES.some((phrase) => lower.includes(phrase))) return false;
  const hasNumber = /\d/.test(text);
  const hasIpOrDomain = /\b\d{1,3}(\.\d{1,3}){3}\b|\b[a-z0-9-]+\.[a-z]{2,}\b/i.test(text);
  return hasNumber || hasIpOrDomain;
}

/**
 * Flags a trace where at least one tool call failed (result.success === false,
 * or a joined fullResult carries an error) but the final answer still reads
 * like it's presenting real data rather than acknowledging the failure —
 * the "is it hallucinating or going off stale twin data" pattern.
 */
export function checkFailedButSubstantiveAnswer(joined: JoinedTrace): Finding | null {
  const failedCalls = joined.steps.flatMap((step) =>
    step.toolCalls.filter((call) => call.result?.success === false || call.fullResult?.error)
  );
  if (failedCalls.length === 0) return null;
  if (!joined.finalResponse || !looksSubstantive(joined.finalResponse)) return null;

  return {
    type: "failed_but_substantive_answer",
    traceIds: [joined.id],
    summary: `Trace has ${failedCalls.length} failed tool call(s) but a substantive-looking final answer — verify it isn't presenting stale/hallucinated data.`,
    detail: {
      userInput: joined.userInput,
      failedTools: failedCalls.map((c) => ({ toolName: c.toolName, error: c.result?.error || c.fullResult?.error })),
      finalResponse: joined.finalResponse,
    },
  };
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "and", "or", "of", "to", "for", "on", "in", "at",
  "what", "which", "how", "does", "do", "did", "show", "me", "list", "all", "give",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1 && !STOPWORDS.has(token))
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const STATUS_WORDS = ["running", "stopped", "online", "offline", "blocked", "allowed", "enabled", "disabled", "exposed"];

/** Extracts the small set of status/fact words present, so two answers to the same
 * underlying question can be compared for a direct contradiction (not just phrasing diffs). */
function extractStatusSignal(text: string): Set<string> {
  const lower = text.toLowerCase();
  return new Set(STATUS_WORDS.filter((word) => lower.includes(word)));
}

const SIMILARITY_THRESHOLD = 0.5;

/**
 * Groups traces whose userInput is near-duplicate (token-overlap above
 * SIMILARITY_THRESHOLD) and flags groups whose final answers disagree on
 * the same underlying status fact (e.g. one says "running", another says
 * "stopped", for what reads like the same question).
 */
export function checkNearDuplicateConsistency(traces: ReasoningTrace[]): Finding[] {
  const withResponses = traces.filter((t) => t.finalResponse && t.finalResponse.trim().length > 0);
  const tokenSets = withResponses.map((t) => tokenize(t.userInput));

  const visited = new Set<number>();
  const findings: Finding[] = [];

  for (let i = 0; i < withResponses.length; i++) {
    if (visited.has(i)) continue;
    const group = [i];
    for (let j = i + 1; j < withResponses.length; j++) {
      if (visited.has(j)) continue;
      if (jaccardSimilarity(tokenSets[i]!, tokenSets[j]!) >= SIMILARITY_THRESHOLD) {
        group.push(j);
      }
    }
    group.forEach((idx) => visited.add(idx));
    if (group.length < 2) continue;

    const groupTraces = group.map((idx) => withResponses[idx]!);
    const statusSignals = groupTraces.map((t) => extractStatusSignal(t.finalResponse!));
    const allStatusWords = new Set(statusSignals.flatMap((s) => Array.from(s)));

    // Contradiction: two mutually-exclusive status words both appear across the group
    // (e.g. "running" in one answer, "stopped" in another, for near-identical questions).
    const CONTRADICTORY_PAIRS: Array<[string, string]> = [
      ["running", "stopped"],
      ["online", "offline"],
      ["blocked", "allowed"],
      ["enabled", "disabled"],
    ];
    const hasContradiction = CONTRADICTORY_PAIRS.some(
      ([a, b]) => allStatusWords.has(a) && allStatusWords.has(b)
    );

    if (hasContradiction) {
      findings.push({
        type: "near_duplicate_inconsistency",
        traceIds: groupTraces.map((t) => t.id),
        summary: `${groupTraces.length} near-identical queries produced contradictory answers.`,
        detail: {
          queries: groupTraces.map((t) => t.userInput),
          responses: groupTraces.map((t) => t.finalResponse),
        },
      });
    }
  }

  return findings;
}
