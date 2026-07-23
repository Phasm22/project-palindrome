#!/usr/bin/env bun
/**
 * Validate dashboard PromQL against a live Prometheus endpoint.
 * - Confirms each panel query executes successfully
 * - Confirms a configurable subset returns data
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://localhost:9090";
const DASHBOARD_PATH = process.env.GRAFANA_DASHBOARD_PATH || "grafana/dashboards/maybeDashboard.json";

interface Target {
  expr?: string;
  refId?: string;
}

interface Panel {
  id?: number;
  title?: string;
  targets?: Target[];
}

interface Dashboard {
  panels?: Panel[];
}

function extractQueries(dashboard: Dashboard) {
  const panelQueries: Array<{ panelId: number; title: string; expr: string; refId: string }> = [];

  for (const panel of dashboard.panels || []) {
    const panelId = panel.id ?? -1;
    const title = panel.title || `Panel ${panelId}`;
    for (const target of panel.targets || []) {
      if (!target.expr) {
        continue;
      }
      panelQueries.push({
        panelId,
        title,
        expr: target.expr,
        refId: target.refId || "A",
      });
    }
  }

  return panelQueries;
}

async function queryPrometheus(expr: string) {
  const response = await fetch(
    `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(expr)}`
  );

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (data.status !== "success") {
    throw new Error(`status=${data.status}`);
  }

  return data.data?.result || [];
}

async function main() {
  const dashboardAbsPath = resolve(DASHBOARD_PATH);
  const raw = readFileSync(dashboardAbsPath, "utf8");
  const dashboard = JSON.parse(raw) as Dashboard;
  const queries = extractQueries(dashboard);

  if (queries.length === 0) {
    throw new Error(`No PromQL queries found in dashboard: ${dashboardAbsPath}`);
  }

  console.log(`Dashboard: ${dashboardAbsPath}`);
  console.log(`Prometheus: ${PROMETHEUS_URL}`);
  console.log(`Queries discovered: ${queries.length}`);
  console.log("");

  let failures = 0;
  const nonEmptyRequired = [
    "pce_api_uptime_seconds",
    "(sum(query_latency_vector_ms_count) or vector(0)) + (sum(query_latency_graph_ms_count) or vector(0)) + (sum(query_latency_hybrid_ms_count) or vector(0))",
  ];

  for (const query of queries) {
    try {
      const result = await queryPrometheus(query.expr);
      console.log(`OK panel=${query.panelId} ref=${query.refId} title="${query.title}" result_series=${result.length}`);

      if (nonEmptyRequired.includes(query.expr) && result.length === 0) {
        console.log(`FAIL panel=${query.panelId} required query returned no data`);
        failures += 1;
      }
    } catch (error: any) {
      console.log(`FAIL panel=${query.panelId} ref=${query.refId} title="${query.title}" error=${error?.message || String(error)}`);
      failures += 1;
    }
  }

  if (failures > 0) {
    throw new Error(`Dashboard verification failed (${failures} query issue(s))`);
  }

  console.log("");
  console.log("Dashboard verification passed.");
}

main().catch((error: any) => {
  console.error("");
  console.error(`Verification failed: ${error?.message || String(error)}`);
  process.exit(1);
});
