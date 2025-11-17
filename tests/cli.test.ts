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
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(text.trim()).toBe("Agent online.");
  });

  test("agent pce command shows usage when no prompt provided", async () => {
    const bunPath = process.execPath || "bun";
    const proc = spawn({
      cmd: [bunPath, "run", join(process.cwd(), "src/cli.ts"), "pce"],
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    });

    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
    expect(text).toContain("Usage: agent pce");
  });

  test("agent help command includes pce", async () => {
    const bunPath = process.execPath || "bun";
    const proc = spawn({
      cmd: [bunPath, "run", join(process.cwd(), "src/cli.ts"), "help"],
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    });

    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(text).toContain("pce");
    expect(text).toContain("Query the PCE API");
  });
});

