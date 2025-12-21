/**
 * Test cases for Intent Classifier
 * 
 * Demonstrates how the classifier handles language variance naturally
 */

import { classifyIntent } from "./intent-classifier";

// Test cases that should all classify as QUERY (metrics/temperature)
const temperatureQueries = [
  "whats the temperature of the different nodes",
  "what's the temperature of the different nodes",
  "what is the temp of nodes",
  "show me node temperatures",
  "how hot are the nodes",
  "check temperature on all nodes",
  "get temp for nodes",
  "tell me the node temps",
];

// Test cases that should all classify as ACTION
const actionQueries = [
  "create a vm on yang",
  "create vm on yang",
  "make a vm in yang",
  "spin up vm on yang",
  "destroy vm-123",
  "delete the vm",
  "remove vm-123",
];

// Test cases that should classify as QUERY (compute)
const computeQueries = [
  "list all vms",
  "show me vms",
  "what vms are running",
  "which vms are on yang",
  "describe the cluster",
];

console.log("=== Temperature Query Classification ===");
for (const query of temperatureQueries) {
  const result = classifyIntent(query);
  console.log(`"${query}"`);
  console.log(`  → ${result.type} (confidence: ${result.confidence.toFixed(2)})`);
  console.log(`  → Domain: ${result.metadata?.domain}, QueryType: ${result.metadata?.queryType}`);
  console.log();
}

console.log("\n=== Action Query Classification ===");
for (const query of actionQueries) {
  const result = classifyIntent(query);
  console.log(`"${query}"`);
  console.log(`  → ${result.type} (confidence: ${result.confidence.toFixed(2)})`);
  console.log(`  → Domain: ${result.metadata?.domain}, ActionType: ${result.metadata?.actionType}`);
  console.log();
}

console.log("\n=== Compute Query Classification ===");
for (const query of computeQueries) {
  const result = classifyIntent(query);
  console.log(`"${query}"`);
  console.log(`  → ${result.type} (confidence: ${result.confidence.toFixed(2)})`);
  console.log(`  → Domain: ${result.metadata?.domain}, QueryType: ${result.metadata?.queryType}`);
  console.log();
}

// Run with: bun run src/reasoning/intent-classifier.test.ts

