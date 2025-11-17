#!/usr/bin/env bun

import { runProvenanceAudit } from "./run-provenance-audit";
import { bootstrapPceApiServer } from "../src/pce/api/server";
import { RunDiagnosticTool } from "../src/tools/RunDiagnosticTool";
import { CreateIncidentTicketTool } from "../src/tools/CreateIncidentTicketTool";
import { LookupUserProfileTool } from "../src/tools/LookupUserProfileTool";
import { sanitizeToolPayload } from "../src/agent/tool-sanitizer";
import type { ExecutionContext } from "../src/types/execution";

const HYBRID_QUERIES = [
  "Which host runs the http-service?",
  "Which service depends on mysql-service?",
  "Where is host-web-01 documented?",
  "What alert mentions host-db-01?",
  "Which load balancer routes traffic to host-web-01?",
];

const TOOL_HTTP_TARGETS = [
  "https://example.com",
  "https://www.cloudflare.com",
  "https://httpbin.org/get",
];

async function runPhaseThreeDod() {
  console.log("[Phase3] Starting provenance audit...");
  await runProvenanceAudit();

  console.log("[Phase3] Spinning up API server for final validation...");
  const { server } = await bootstrapPceApiServer({
    port: 0,
    fusionConfig: {
      minTotalScore: 0.5,
    },
  });
  await server.start();
  const baseUrl = `http://localhost:${server.getPort()}`;

  try {
    await runHybridValidation(baseUrl);
    await runToolValidation();
    await verifyMetrics(baseUrl);
    console.log("PHASE III DOD PASSED ✔️");
  } finally {
    await server.stop();
  }
}

async function runHybridValidation(baseUrl: string) {
  console.log("[Phase3] Validating hybrid queries...");
  let successCount = 0;

  for (const query of HYBRID_QUERIES) {
    const response = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, aclGroup: "admin", userId: "phase3-dod" }),
    });

    if (!response.ok) {
      throw new Error(`Hybrid query failed (${query}) HTTP ${response.status}`);
    }

    const payload: any = await response.json();
    const data = payload.data;
    if (!data) {
      throw new Error(`Hybrid query returned no data for '${query}'`);
    }

    if (data.fallbackMode) {
      throw new Error(`Fallback triggered for '${query}' (${data.fallbackMode})`);
    }

    if (!data.sTotalScore || data.sTotalScore <= 0) {
      throw new Error(`Invalid score for '${query}'`);
    }

    const provenance = data.context?.provenance ?? [];
    if (!provenance.length) {
      throw new Error(`Missing provenance for '${query}'`);
    }
    for (const entry of provenance) {
      if (!entry.versionHash || !entry.sourcePath) {
        throw new Error(`Incomplete provenance entry for '${query}'`);
      }
    }

    const hasContext =
      (data.context?.semanticChunks?.length ?? 0) > 0 ||
      (data.context?.structuralPaths?.length ?? 0) > 0;
    if (!hasContext) {
      throw new Error(`Empty fused context for '${query}'`);
    }

    successCount += 1;
    console.log(`[Phase3] ✓ Hybrid query '${query}' validated (score=${data.sTotalScore.toFixed(2)})`);
  }

  if (successCount < HYBRID_QUERIES.length) {
    throw new Error("Hybrid validation did not cover all queries");
  }
}

async function runToolValidation() {
  console.log("[Phase3] Exercising cognitive tools...");
  const context: ExecutionContext = { toolName: "phase3-dod", startedAt: Date.now() };
  const diagnostics = new RunDiagnosticTool();
  const incidentTool = new CreateIncidentTicketTool();
  const directoryTool = new LookupUserProfileTool();

  const toolResults: Array<{ name: string; success: boolean }> = [];

  for (const target of TOOL_HTTP_TARGETS) {
    const result = await diagnostics.execute(
      {
        command: "http_check",
        target,
        timeoutMs: 5000,
      },
      context
    );
    if (result.error) {
      throw new Error(`Diagnostic tool failed for ${target}: ${result.error}`);
    }
    sanitizeToolPayload(result.data);
    toolResults.push({ name: `run_diagnostic_command (${target})`, success: true });
    console.log(`[Phase3] ✓ HTTP diagnostic against ${target}`);
  }

  const incidentResult = await incidentTool.execute(
    {
      title: "Phase III validation incident",
      description: "Synthetic incident to verify tooling",
      severity: "low",
      service: "pce-api",
      tags: ["phase3", "dod"],
      autoNotify: true,
    },
    context
  );
  if (incidentResult.error) {
    throw new Error(`Incident tool failed: ${incidentResult.error}`);
  }
  sanitizeToolPayload(incidentResult.data);
  toolResults.push({ name: "create_incident_ticket", success: true });
  console.log("[Phase3] ✓ Incident ticket generated");

  const lookupResult = await directoryTool.execute(
    { identifierType: "username", identifier: "jdoe" },
    context
  );
  if (lookupResult.error) {
    throw new Error(`Lookup tool failed: ${lookupResult.error}`);
  }
  sanitizeToolPayload(lookupResult.data);
  toolResults.push({ name: "lookup_user_profile", success: true });
  console.log("[Phase3] ✓ User profile lookup completed");

  if (toolResults.length < 5) {
    throw new Error("Tool validation executed fewer than 5 tool-use queries");
  }
}

async function verifyMetrics(baseUrl: string) {
  console.log("[Phase3] Verifying metrics counters...");
  const res = await fetch(`${baseUrl}/metrics`);
  if (!res.ok) {
    throw new Error(`Failed to fetch metrics (HTTP ${res.status})`);
  }
  const body: any = await res.json();
  const counters = body.data?.counters ?? {};
  const fallbackGraph = counters.fallback_graph_down_count ?? 0;
  const noAnswer = counters.no_answer_count ?? 0;

  if (fallbackGraph !== 0 || noAnswer !== 0) {
    throw new Error(
      `Fallback counters non-zero (fallback_graph_down_count=${fallbackGraph}, no_answer_count=${noAnswer})`
    );
  }

  console.log("[Phase3] ✓ Metrics look clean (no fallback misfires)");
}

runPhaseThreeDod().catch((error) => {
  console.error("Phase III DOD run failed ❌", error);
  process.exit(1);
});
