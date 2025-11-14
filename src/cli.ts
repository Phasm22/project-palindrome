#!/usr/bin/env bun

import { runAgent } from "./agent/runner";
import { loadTools } from "./agent/tool-loader";

const args = process.argv.slice(2);

if (args[0] === "hello") {
  console.log("Agent online.");
  process.exit(0);
}

if (args[0] === "ask") {
  const question = args.slice(1).join(" ");
  if (!question) {
    console.log("Usage: agent ask \"your question\"");
    process.exit(1);
  }
  const res = await runAgent(question);
  console.log(res.text);
  process.exit(0);
}

if (args[0] === "glances") {
  const tools = loadTools();
  const glances = tools.find(t => t.metadata.name === "glances")!;
  const res = await glances.execute(
    { section: "all" },
    { toolName: "glances", startedAt: Date.now() }
  );
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}

// Default behavior or help
if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
  console.log("Usage: agent <command>");
  console.log("Commands:");
  console.log("  hello   - Check if agent is online");
  console.log("  ask     - Ask the agent a question");
  console.log("  glances - Test Glances tool directly");
  process.exit(0);
}

console.log(`Unknown command: ${args[0]}`);
process.exit(1);
