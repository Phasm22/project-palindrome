import { z } from "zod";

export type ParseToolArgsResult =
  | { ok: true; args: Record<string, any> }
  | { ok: false; error: string };

/**
 * Parse and optionally validate JSON tool arguments.
 *
 * - Returns `{ ok: false }` with a descriptive error on JSON parse failure.
 * - When a Zod schema is provided, runs `safeParse` for schema validation
 *   (defense-in-depth; tools also validate internally via safeParse).
 * - Returns `{ ok: true, args }` on success.
 */
export function parseToolArgs(
  rawArguments: string | undefined,
  schema?: z.ZodTypeAny
): ParseToolArgsResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = rawArguments ? JSON.parse(rawArguments) : {};
  } catch (err) {
    return { ok: false, error: `Invalid JSON in tool arguments: ${String(err)}` };
  }
  if (schema) {
    const result = schema.safeParse(parsed);
    if (!result.success) {
      return {
        ok: false,
        error: `Tool argument validation failed: ${result.error.message}`,
      };
    }
    return { ok: true, args: result.data as Record<string, any> };
  }
  return { ok: true, args: parsed };
}
