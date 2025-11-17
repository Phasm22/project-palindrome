#!/usr/bin/env bun

// Bun auto-loads .env, but dotenv helps with compatibility
// Remove quotes from env vars if present
if (typeof process !== "undefined" && process.env) {
  for (const key in process.env) {
    if (process.env[key] && typeof process.env[key] === "string") {
      process.env[key] = process.env[key].replace(/^["']|["']$/g, "");
    }
  }
}

import { runAgent } from "./agent/runner";
import { loadTools } from "./agent/tool-loader";
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
} else if (args[0] === "opnsense") {
  const tools = loadTools();
  const opnsense = tools.find(t => t.metadata.name === "opnsense_manage")!;
  
  if (args[1] === "status") {
    const res = await opnsense.execute(
      { action: "system_status" },
      { toolName: "opnsense_manage", startedAt: Date.now() }
    );
    console.log(JSON.stringify(res, null, 2));
  } else if (args[1] === "aliases") {
    const res = await opnsense.execute(
      { action: "list_aliases" },
      { toolName: "opnsense_manage", startedAt: Date.now() }
    );
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log("Usage: agent opnsense <status|aliases>");
    process.exit(1);
  }
  process.exit(0);
} else if (args[0] === "ssh") {
  const tools = loadTools();
  const ssh = tools.find(t => t.metadata.name === "ssh_execute")!;
  
  if (args.length < 3) {
    console.log("Usage: agent ssh <host> <command>");
    console.log("Example: agent ssh 172.16.0.1 'du -sh /*'");
    process.exit(1);
  }
  
  const host = args[1];
  const command = args.slice(2).join(" ");
  
  const res = await ssh.execute(
    { host, command },
    { toolName: "ssh_execute", startedAt: Date.now() }
  );
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
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
  console.log("  hello         - Check if agent is online");
  console.log("  ask           - Ask the agent a question");
  console.log("  repl          - Start interactive REPL");
  console.log("  glances       - Test Glances tool directly");
  console.log("  opnsense      - Test OPNsense tool directly");
  console.log("    status      - Get OPNsense system status");
  console.log("    aliases     - List OPNsense firewall aliases");
  console.log("  ssh           - Test SSH tool directly");
  console.log("    <host> <cmd> - Execute approved SSH command");
  process.exit(0);
} else {
  console.log(`Unknown command: ${args[0]}`);
  process.exit(1);
}
