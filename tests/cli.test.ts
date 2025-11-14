import { describe, test, expect } from "bun:test";
import { spawn } from "bun";
import { join } from "path";

describe("CLI", () => {
  test("agent hello command returns 'Agent online.'", async () => {
    const bunPath = process.execPath || "bun";
    const proc = spawn({
      cmd: [bunPath, "run", join(process.cwd(), "src/cli.ts"), "hello"],
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    });

    const text = await new Response(proc.stdout).text();
    expect(text.trim()).toBe("Agent online.");
  });
});

