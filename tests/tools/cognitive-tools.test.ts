import { describe, it, expect, afterAll } from "bun:test";
import os from "node:os";
import path from "node:path";
import { rm, readFile } from "node:fs/promises";
import { RunDiagnosticTool } from "../../src/tools/RunDiagnosticTool";
import { CreateIncidentTicketTool } from "../../src/tools/CreateIncidentTicketTool";
import { LookupUserProfileTool } from "../../src/tools/LookupUserProfileTool";
import type { ExecutionContext } from "../../src/types";

function makeContext(toolName: string): ExecutionContext {
  return { toolName, startedAt: Date.now() };
}

const tmpIncidentLog = path.join(os.tmpdir(), `incidents-${Date.now()}.jsonl`);
process.env.PCE_INCIDENT_LOG_PATH = tmpIncidentLog;

describe("Phase III tools", () => {
  afterAll(async () => {
    delete process.env.PCE_INCIDENT_LOG_PATH;
    try {
      await rm(tmpIncidentLog);
    } catch {}
  });

  it("runs HTTP diagnostic checks", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("ok", { status: 200 });
      },
    });

    try {
      const tool = new RunDiagnosticTool();
      const result = await tool.execute(
        {
          command: "http_check",
          target: `http://127.0.0.1:${server.port}/healthz`,
          timeoutMs: 1000,
        },
        makeContext("run_diagnostic_command")
      );

      expect(result.error).toBeUndefined();
      expect(result.data?.http?.statusCode).toBe(200);
      expect(result.data?.summary).toContain("HTTP 200");
    } finally {
      server.stop();
    }
  });

  it("persists incident tickets", async () => {
    const tool = new CreateIncidentTicketTool();
    const result = await tool.execute(
      {
        title: "Database latency breach",
        description: "Primary replica latency sustained above 80ms",
        severity: "high",
        service: "postgres-cluster",
        tags: ["latency", "db"],
        autoNotify: false,
      },
      makeContext("create_incident_ticket")
    );

    expect(result.error).toBeUndefined();
    expect(result.data?.ticketId).toMatch(/^INC-/);

    const logContents = await readFile(tmpIncidentLog, "utf-8");
    expect(logContents).toContain(result.data?.ticketId);
  });

  it("looks up user profiles by username", async () => {
    const tool = new LookupUserProfileTool();
    const result = await tool.execute(
      {
        identifier: "jdoe",
        identifierType: "username",
        includeContact: false,
        includeAccess: true,
      },
      makeContext("lookup_user_profile")
    );

    expect(result.error).toBeUndefined();
    expect(result.data?.roles).toContain("sre");
    expect(result.data?.access).toContain("grafana");
    expect(result.data?.contact).toBeUndefined();
  });
});
