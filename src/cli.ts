#!/usr/bin/env bun

const args = process.argv.slice(2);

if (args[0] === "hello") {
  console.log("Agent online.");
  process.exit(0);
}

// Default behavior or help
if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
  console.log("Usage: agent <command>");
  console.log("Commands:");
  console.log("  hello  - Check if agent is online");
  process.exit(0);
}

console.log(`Unknown command: ${args[0]}`);
process.exit(1);
