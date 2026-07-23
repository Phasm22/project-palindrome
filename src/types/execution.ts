export type ExecutionContext = {
  toolName: string;
  startedAt: number;
};

export type ACLGroup = string;

export type ExecutionResult<T = any> = {
  data?: T;
  error?: string;
  /**
   * Explicit success flag. Backward-compatible: downstream code that derives
   * `success = !result.error` continues to work because `error` is always set
   * whenever `success === false`. Prefer reading this field when present.
   */
  success?: boolean;
  durationMs?: number;
};

/**
 * Normalize a domain action's return value into a single authoritative
 * ExecutionResult (Epic E1, RM-04).
 *
 * A domain action can signal failure in two ways:
 *  1. by throwing (handled by the caller's try/catch), or
 *  2. by RESOLVING with `{ success: false, message?/error?, ... }` WITHOUT
 *     throwing.
 *
 * Case (2) previously slipped through as `{ data: result }` with no `error`,
 * so downstream (`success = !result.error`) treated a failed action as a
 * success. This helper inspects the action's own `success` field and promotes
 * a `false` into `ExecutionResult.error` while preserving `data: result`,
 * mirroring the pattern already used in ApplicationLifecycleTool.
 */
export function toExecutionResult<T = unknown>(
  result: T,
  startedAt: number
): ExecutionResult<T> {
  const durationMs = Date.now() - startedAt;
  const maybe = result as
    | { success?: unknown; error?: unknown; message?: unknown }
    | null
    | undefined;

  if (maybe && typeof maybe === "object" && maybe.success === false) {
    const error =
      (typeof maybe.error === "string" && maybe.error) ||
      (typeof maybe.message === "string" && maybe.message) ||
      "Action reported failure";
    return { data: result, error, success: false, durationMs };
  }

  return { data: result, success: true, durationMs };
}
