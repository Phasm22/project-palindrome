#!/usr/bin/env bun
/**
 * Diagnostic script to check what metrics are available from PCE API and Prometheus
 */

const PCE_API_URL = process.env.PCE_API_URL || "http://localhost:4000";
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://localhost:9090";

async function checkPceApiMetrics() {
  console.log("🔍 Checking PCE API metrics endpoint...");
  console.log(`   URL: ${PCE_API_URL}/metrics\n`);

  try {
    const response = await fetch(`${PCE_API_URL}/metrics`);
    if (!response.ok) {
      console.error(`❌ Failed to fetch metrics: ${response.status} ${response.statusText}`);
      return;
    }

    const text = await response.text();
    const lines = text.split("\n").filter((line) => line.trim() && !line.startsWith("#"));

    console.log(`✅ PCE API metrics endpoint is accessible`);
    console.log(`   Found ${lines.length} metric lines\n`);

    // Extract unique metric names
    const metricNames = new Set<string>();
    for (const line of lines) {
      const match = line.match(/^([a-z_][a-z0-9_]*)\s/);
      if (match) {
        metricNames.add(match[1]);
      }
    }

    console.log(`📊 Available metrics (${metricNames.size}):`);
    const sorted = Array.from(metricNames).sort();
    for (const name of sorted) {
      console.log(`   - ${name}`);
    }
    console.log("");

    // Show sample of actual metric values
    console.log("📈 Sample metric values (first 10):");
    for (const line of lines.slice(0, 10)) {
      console.log(`   ${line}`);
    }
    console.log("");

    return { metricNames: Array.from(metricNames), rawText: text };
  } catch (error: any) {
    console.error(`❌ Error fetching PCE API metrics: ${error.message}`);
    if (error.code === "ECONNREFUSED") {
      console.error("   → Is the PCE API server running?");
    }
    return null;
  }
}

async function checkPrometheusTargets() {
  console.log("🔍 Checking Prometheus targets...");
  console.log(`   URL: ${PROMETHEUS_URL}\n`);

  try {
    const response = await fetch(`${PROMETHEUS_URL}/api/v1/targets`);
    if (!response.ok) {
      console.error(`❌ Failed to fetch targets: ${response.status} ${response.statusText}`);
      return;
    }

    const data = await response.json();
    console.log(`✅ Prometheus is accessible\n`);

    if (data.data?.activeTargets) {
      console.log("🎯 Active targets:");
      for (const target of data.data.activeTargets) {
        const health = target.health === "up" ? "✅" : "❌";
        console.log(`   ${health} ${target.labels.job || "unknown"}: ${target.scrapeUrl}`);
        console.log(`      Health: ${target.health}`);
        console.log(`      Last scrape: ${target.lastScrape || "never"}`);
        if (target.lastError) {
          console.log(`      Error: ${target.lastError}`);
        }
      }
      console.log("");
    }
  } catch (error: any) {
    console.error(`❌ Error fetching Prometheus targets: ${error.message}`);
    if (error.code === "ECONNREFUSED") {
      console.error("   → Is Prometheus running?");
    }
  }
}

async function checkPrometheusMetrics() {
  console.log("🔍 Checking Prometheus for PCE metrics...");
  console.log(`   URL: ${PROMETHEUS_URL}\n`);

  try {
    // Query for all metrics that start with query_, ingestion_, pce_
    const queries = [
      "query_latency",
      "query_result_count",
      "query_slow_queries",
      "query_complexity",
      "ingestion_",
      "pce_api_uptime",
      "pce_log_",
      "error_count",
    ];

    console.log("📊 Checking for metrics in Prometheus:\n");

    for (const prefix of queries) {
      const response = await fetch(
        `${PROMETHEUS_URL}/api/v1/label/__name__/values?match[]=${prefix}*`
      );
      if (response.ok) {
        const data = await response.json();
        if (data.data && data.data.length > 0) {
          console.log(`   ✅ Found ${data.data.length} metrics matching '${prefix}*':`);
          for (const name of data.data.slice(0, 5)) {
            console.log(`      - ${name}`);
          }
          if (data.data.length > 5) {
            console.log(`      ... and ${data.data.length - 5} more`);
          }
        } else {
          console.log(`   ❌ No metrics found matching '${prefix}*'`);
        }
      }
    }
    console.log("");

    // Try a specific query to see if we get data
    console.log("🔍 Testing specific metric queries:\n");
    const testQueries = [
      "pce_api_uptime_seconds",
      "query_latency_vector_ms_avg",
      "query_latency_graph_ms_avg",
      "query_latency_hybrid_ms_avg",
      "query_result_count_avg",
    ];

    for (const metric of testQueries) {
      const response = await fetch(
        `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(metric)}`
      );
      if (response.ok) {
        const data = await response.json();
        if (data.data?.result && data.data.result.length > 0) {
          const value = data.data.result[0].value[1];
          console.log(`   ✅ ${metric} = ${value}`);
        } else {
          console.log(`   ❌ ${metric} - No data`);
        }
      }
    }
    console.log("");
  } catch (error: any) {
    console.error(`❌ Error querying Prometheus: ${error.message}`);
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("PCE Metrics Diagnostic Tool");
  console.log("=".repeat(60));
  console.log("");

  const apiMetrics = await checkPceApiMetrics();
  await checkPrometheusTargets();
  await checkPrometheusMetrics();

  console.log("=".repeat(60));
  console.log("Summary");
  console.log("=".repeat(60));

  if (apiMetrics) {
    console.log(`✅ PCE API metrics endpoint is working`);
    console.log(`   Found ${apiMetrics.metricNames.length} unique metrics`);
  } else {
    console.log(`❌ PCE API metrics endpoint is not accessible`);
    console.log(`   → Check if PCE API is running on ${PCE_API_URL}`);
  }

  console.log("");
  console.log("💡 Tips:");
  console.log("   - If metrics are empty, try making some API queries first");
  console.log("   - Check Prometheus targets to ensure scraping is working");
  console.log("   - Verify Grafana datasource is configured correctly");
  console.log("");
}

main().catch(console.error);

