#!/usr/bin/env bun

import { runAgent } from "./agent/runner";
import { loadTools } from "./agent/tool-loader";
import { queryPCE } from "./agent/pce-client";
import readline from "readline";

const args = process.argv.slice(2);

if (args[0] === "hello") {
  console.log("Agent online.");
  process.exit(0);
} else if (args[0] === "ask") {
  const question = args.slice(1).join(" ");
  if (!question) {
    console.log("Usage: agent ask \"your question\"");
    process.exit(1);
  }
  const res = await runAgent(question);
  console.log(res.text);
  process.exit(0);
} else if (args[0] === "glances") {
  const tools = loadTools();
  const glances = tools.find(t => t.metadata.name === "glances")!;
  const res = await glances.execute(
    { section: "all" },
    { toolName: "glances", startedAt: Date.now() }
  );
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
} else if (args[0] === "pce") {
  const prompt = args.slice(1).join(" ");
  if (!prompt) {
    console.log("Usage: agent pce \"your question\"");
    process.exit(1);
  }

  try {
    // Use a default userId if not provided via env var
    const userId = process.env.PCE_USER_ID || "default-user";
    const response = await queryPCE(userId, prompt);

    // Print the answer
    console.log("\n" + response.answer + "\n");

    // Optionally log top sources and sTotalScore
    if (response.sTotalScore !== null) {
      console.log(`Total Score: ${response.sTotalScore.toFixed(4)}`);
    }

    if (response.sources && response.sources.length > 0) {
      console.log("\nTop Sources:");
      response.sources.slice(0, 5).forEach((source, idx) => {
        const sourcePath = source.sourcePath || source.chunkId || "Unknown";
        const score = source.score?.toFixed(4) || "N/A";
        console.log(`  ${idx + 1}. ${sourcePath} (score: ${score})`);
      });
    }

    process.exit(0);
  } catch (err: any) {
    console.error(`Error querying PCE: ${err.message}`);
    process.exit(1);
  }
} else if (args[0] === "repl") {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log("Project Palindrome REPL");
  console.log("Type 'exit' or 'quit' to exit\n");

  const askLoop = () => {
    rl.question(">> ", async (input) => {
      if (input.trim().toLowerCase() === "exit" || input.trim().toLowerCase() === "quit") {
        rl.close();
        process.exit(0);
      }

      if (input.trim()) {
        try {
          const res = await runAgent(input);
          console.log(res.text || "No response.");
          console.log(); // Empty line for readability
        } catch (err: any) {
          console.error(`Error: ${err.message}`);
        }
      }

      askLoop();
    });
  };

  askLoop();
  // REPL runs indefinitely until user exits
} else if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
  console.log("Usage: agent <command>");
  console.log("Commands:");
  console.log("  hello   - Check if agent is online");
  console.log("  ask     - Ask the agent a question");
  console.log("  pce     - Query the PCE API (Hybrid RAG)");
  console.log("  repl    - Start interactive REPL");
  console.log("  glances - Test Glances tool directly");
  process.exit(0);
} else {
  console.log(`Unknown command: ${args[0]}`);
  process.exit(1);
}
