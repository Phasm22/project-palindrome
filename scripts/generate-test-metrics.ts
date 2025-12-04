#!/usr/bin/env bun
/**
 * Generate test metrics by making API calls to the PCE API
 * This helps populate the dashboard with data
 */

const PCE_API_URL = process.env.PCE_API_URL || "http://localhost:4000";

async function makeTestQuery(query: string, queryType: "vector" | "graph" | "hybrid" = "hybrid") {
  try {
    const response = await fetch(`${PCE_API_URL}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        userId: "test-user",
        aclGroup: "ops",
        queryType,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`  ❌ Query failed: ${response.status} - ${text}`);
      return false;
    }

    const data = await response.json();
    console.log(`  ✅ Query successful (${data.data?.sTotalScore || "N/A"} score)`);
    return true;
  } catch (error: any) {
    console.error(`  ❌ Error: ${error.message}`);
    return false;
  }
}

async function generateTestMetrics() {
  console.log("🚀 Generating test metrics for PCE API...");
  console.log(`   API URL: ${PCE_API_URL}\n`);

  const queries = [
    { query: "What VMs are running?", type: "hybrid" as const },
    { query: "Show me Proxmox nodes", type: "graph" as const },
    { query: "network configuration", type: "vector" as const },
    { query: "terraform infrastructure", type: "hybrid" as const },
    { query: "docker containers", type: "vector" as const },
  ];

  console.log("📊 Making test queries to generate metrics...\n");

  for (let i = 0; i < queries.length; i++) {
    const { query, type } = queries[i];
    console.log(`${i + 1}. ${type.toUpperCase()} query: "${query}"`);
    await makeTestQuery(query, type);
    
    // Small delay between queries
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log("\n✅ Test queries completed!");
  console.log("\n💡 Next steps:");
  console.log("   1. Wait 15-30 seconds for Prometheus to scrape metrics");
  console.log("   2. Refresh your Grafana dashboard");
  console.log("   3. Run: bun run scripts/check-metrics.ts to verify metrics");
  console.log("");
}

generateTestMetrics().catch(console.error);

