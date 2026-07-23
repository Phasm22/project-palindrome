import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const USAGE_LOG_PATH = join(import.meta.dir, "../../../logs/usage.log");

export type PalindromeUsageEvent = "usage.palindrome.chat_created" | "usage.palindrome.chat_opened";

/**
 * Dedicated usage.log, separate from palindrome-api.log, so a quiet period
 * with no chat activity isn't misread as the pce-api service being down.
 * See argus/docs/usage-dashboard-rollout.md (shared WATCH_JSON_EVENT_PATTERN contract).
 */
export function emitUsageEvent(event: PalindromeUsageEvent, metrics?: Record<string, unknown>) {
  const dir = dirname(USAGE_LOG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const payload: Record<string, unknown> = {
    event,
    ts: new Date().toISOString(),
  };
  if (metrics) {
    payload.metrics = metrics;
  }
  appendFileSync(USAGE_LOG_PATH, `${JSON.stringify(payload)}\n`, "utf8");
}
