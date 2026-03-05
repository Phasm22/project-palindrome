#!/usr/bin/env bun
/**
 * Diagnostic script to validate PCE metrics export and Prometheus scraping.
 */

const PCE_API_URL = process.env.PCE_API_URL || "http://localhost:4000";
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://localhost:9090";
const SCRAPE_JOB = process.env.PROMETHEUS_SCRAPE_JOB || "pce-api";

async function fetchJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} (${url})`);
  }
  return response.json();
}

async function checkPrometheusEndpoint() {
  console.log("1) Checking Prometheus target health...");

  const data = await fetchJson(`${PROMETHEUS_URL}/api/v1/targets`);
  const activeTargets = data?.data?.activeTargets || [];
  const pceTarget = activeTargets.find((target: any) => target?.labels?.job === SCRAPE_JOB);

  if (!pceTarget) {
    throw new Error(`Prometheus has no active target for job='${SCRAPE_JOB}'`);
  }

  const isUp = pceTarget.health === "up";
  const scrapeUrl = pceTarget.scrapeUrl || "unknown";
  console.log(`   Target: ${scrapeUrl}`);
  console.log(`   Health: ${pceTarget.health}`);
  console.log(`   Last scrape: ${pceTarget.lastScrape || "never"}`);

  if (!isUp) {
    throw new Error(`Prometheus target '${SCRAPE_JOB}' is down: ${pceTarget.lastError || "unknown error"}`);
  }

  return pceTarget;
}

async function checkPcePrometheusExport() {
  console.log("2) Checking PCE Prometheus exporter format...");
  const response = await fetch(`${PCE_API_URL}/metrics?format=prometheus`);
  if (!response.ok) {
    throw new Error(`PCE metrics endpoint failed: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();
  const metricLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  if (metricLines.length === 0) {
    throw new Error("PCE exporter returned no metric samples");
  }

  const required = [
    "pce_api_uptime_seconds",
    "pce_metrics_export_timestamp_seconds",
    "pce_process_resident_memory_bytes",
  ];

  for (const metricName of required) {
    const present = metricLines.some((line) => line.startsWith(`${metricName} `));
    if (!present) {
      throw new Error(`Required exporter metric is missing: ${metricName}`);
    }
  }

  console.log(`   Exported sample count: ${metricLines.length}`);
}

async function queryPrometheusInstant(expr: string) {
  const data = await fetchJson(
    `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(expr)}`
  );

  if (data?.status !== "success") {
    throw new Error(`Prometheus query failed: ${expr}`);
  }

  return data?.data?.result || [];
}

async function checkPrometheusDataAvailability() {
  console.log("3) Checking Prometheus has current PCE data...");

  const checks: Array<{ expr: string; expectNonEmpty: boolean }> = [
    { expr: 'up{job="pce-api"}', expectNonEmpty: true },
    { expr: "pce_api_uptime_seconds", expectNonEmpty: true },
    { expr: "pce_metrics_export_timestamp_seconds", expectNonEmpty: true },
    { expr: "pce_process_resident_memory_bytes", expectNonEmpty: true },
    { expr: "sum(api_http_requests_total_count) or vector(0)", expectNonEmpty: true },
  ];

  for (const { expr, expectNonEmpty } of checks) {
    const result = await queryPrometheusInstant(expr);
    const ok = !expectNonEmpty || result.length > 0;
    console.log(`   ${ok ? "OK" : "FAIL"} ${expr}`);
    if (!ok) {
      throw new Error(`No data for required query: ${expr}`);
    }
  }
}

async function main() {
  console.log("PCE Metrics Diagnostic Tool");
  console.log(`PCE API: ${PCE_API_URL}`);
  console.log(`Prometheus: ${PROMETHEUS_URL}`);
  console.log("");

  await checkPrometheusEndpoint();
  await checkPcePrometheusExport();
  await checkPrometheusDataAvailability();

  console.log("");
  console.log("All checks passed.");
}

main().catch((error: any) => {
  console.error("");
  console.error(`Check failed: ${error?.message || String(error)}`);
  process.exit(1);
});
