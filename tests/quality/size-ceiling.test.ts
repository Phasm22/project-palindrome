import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const RUNNER_CEILING = 2_431;
const HANDLE_EXECUTE_CEILING = 2_279;
const COMBINED_CEILING = 4_710;

function countLines(path: string): number {
  const source = readFileSync(path, "utf8");
  if (source.length === 0) {
    return 0;
  }

  const newlineCount = source.match(/\r\n|\n|\r/g)?.length ?? 0;
  return newlineCount + (/(?:\r\n|\n|\r)$/.test(source) ? 0 : 1);
}

describe("agent execution seam size ceiling", () => {
  const runnerLines = countLines(
    resolve(import.meta.dir, "../../src/agent/runner.ts"),
  );
  const handleExecuteLines = countLines(
    resolve(import.meta.dir, "../../src/agent/handlers/handle-execute.ts"),
  );

  // Ratchet: these ceilings may only move down in future PRs, never up without
  // an explicit decision to expand the execution seam.
  test("keeps each execution file within its absolute ceiling", () => {
    expect(runnerLines).toBeLessThanOrEqual(RUNNER_CEILING);
    expect(handleExecuteLines).toBeLessThanOrEqual(HANDLE_EXECUTE_CEILING);
  });

  test("keeps the combined execution seam within its absolute ceiling", () => {
    expect(runnerLines + handleExecuteLines).toBeLessThanOrEqual(
      COMBINED_CEILING,
    );
  });
});
