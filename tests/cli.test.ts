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

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    // Combine stdout and stderr, filter out dotenv/info messages
    const allText = stdout + stderr;
    const cleanText = allText.split('\n').filter(line => 
      !line.includes('[dotenv]') && 
      !line.includes('[info]') &&
      line.trim().length > 0
    ).join('\n').trim();
    // Should contain "Agent online." even if there's other output
    expect(cleanText).toContain("Agent online.");
  });

  test("agent ssh command returns formatted output (not raw JSON)", async () => {
    const bunPath = process.execPath || "bun";
    const proc = spawn({
      cmd: [bunPath, "run", join(process.cwd(), "src/cli.ts"), "ssh", "invalid-host", "uptime"],
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    });

    const text = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1); // Should exit with error code
    // Should not be raw JSON, should be formatted error message
    expect(text).toContain("Error:");
    expect(text).not.toContain('"error"'); // Not raw JSON
  });
});

