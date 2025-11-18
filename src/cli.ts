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
import type { ExecutionResult } from "./types/execution";
import { queryPCE } from "./agent/pce-client";
import readline from "readline";

/**
 * Formats tool execution results for user-friendly CLI output
 */
function formatToolOutput(result: ExecutionResult, toolName: string): string {
  if (result.error) {
    return `❌ Error: ${result.error}`;
  }

  // Format based on tool type
  switch (toolName) {
    case "ssh_execute":
      if (result.data?.stdout) {
        // Clean up SSH output (remove extra noise like SHA256 fingerprints)
        const stdout = result.data.stdout
          .split("\n")
          .filter(line => {
            const trimmed = line.trim();
            // Filter out SSH fingerprints and other noise
            return trimmed && 
                   !trimmed.match(/^sha256\s+/i) &&
                   !trimmed.match(/^[A-F0-9]{2}(\s+[A-F0-9]{2}){15}$/) &&
                   !trimmed.match(/^[a-f0-9]{64}$/);
          })
          .join("\n")
          .trim();
        return stdout || "(no output)";
      }
      return result.data?.stderr || "(no output)";

    case "opnsense_manage":
      // For OPNsense, show formatted JSON (it's usually structured data)
      return JSON.stringify(result.data, null, 2);

    case "glances":
      // For Glances, show formatted JSON (metrics data)
      return JSON.stringify(result.data, null, 2);

    case "mcp_opnsense":
      // For MCP OPNsense, show formatted JSON (structured data)
      return JSON.stringify(result.data, null, 2);

    case "proxmox_readonly":
      // For Proxmox, use the CLI formatter
      // This will be handled in the proxmox command handler
      return JSON.stringify(result.data, null, 2);

    default:
      // Default: formatted JSON
      return JSON.stringify(result.data, null, 2);
  }
}

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
  console.log(formatToolOutput(res, "glances"));
  process.exit(res.error ? 1 : 0);
} else if (args[0] === "pce") {
  // Parse flags
  const flags: { [key: string]: boolean } = {};
  const nonFlagArgs: string[] = [];
  
  for (const arg of args.slice(1)) {
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = true;
    } else {
      nonFlagArgs.push(arg);
    }
  }
  
  const prompt = nonFlagArgs.join(" ");
  if (!prompt) {
    console.log("Usage: agent pce [--yes|--auto-approve] \"your question\"");
    console.log("\nFlags:");
    console.log("  --yes, --auto-approve    Auto-approve high-risk operations (write actions)");
    process.exit(1);
  }

  try {
    // Use runAgent directly to enable tool calling (TL-1C)
    // This allows the LLM to autonomously select and execute OPNsense tools
    const userId = process.env.PCE_USER_ID || "default-user";
    const aclGroup = process.env.PCE_ACL_GROUP || "viewer";
    
    // Handle confirmation for write operations
    const autoApprove = flags.yes || flags["auto-approve"] || process.env.PCE_AUTO_APPROVE_HIGH_RISK_TOOLS === "true";
    
    const confirmHighRisk = async (info: { toolName: string; parameters: Record<string, any>; risk: string }): Promise<boolean> => {
      if (autoApprove) {
        console.log(`\n⚠️  Auto-approving ${info.risk}-risk operation: ${info.toolName}`);
        console.log(`   Parameters: ${JSON.stringify(info.parameters, null, 2)}\n`);
        return true;
      }
      
      // Interactive confirmation
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error(`\n❌ Cannot prompt for confirmation in non-interactive mode.`);
        console.error(`   Use --yes flag or set PCE_AUTO_APPROVE_HIGH_RISK_TOOLS=true to auto-approve.\n`);
        return false;
      }
      
      return await new Promise((resolve) => {
        const readline = require("readline");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        console.log(`\n⚠️  High-risk operation requires confirmation:`);
        console.log(`   Tool: ${info.toolName}`);
        console.log(`   Risk: ${info.risk}`);
        console.log(`   Parameters: ${JSON.stringify(info.parameters, null, 2)}`);
        rl.question(`\nApprove this operation? (y/N): `, (answer: string) => {
          rl.close();
          const approved = answer.trim().toLowerCase().startsWith("y");
          if (approved) {
            console.log("✅ Operation approved.\n");
          } else {
            console.log("❌ Operation cancelled.\n");
          }
          resolve(approved);
        });
      });
    };
    
    // Use runAgent which includes tool calling, RAG context, and LLM reasoning
    const response = await runAgent(prompt, {
      userId,
      aclGroup,
      ragBaseUrl: process.env.PCE_API_URL || "http://localhost:4000",
      confirmHighRisk,
    });
    
    console.log(response.text);
    process.exit(0);
  } catch (error: any) {
    console.error("Error:", error.message);
    process.exit(1);
  }
} else if (args[0] === "pce-api") {
  // Legacy API-only mode (RAG only, no tool calling)
  const prompt = args.slice(1).join(" ");
  if (!prompt) {
    console.log("Usage: agent pce-api \"your question\"");
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
} else if (args[0] === "opnsense") {
  const tools = loadTools();
  const opnsense = tools.find(t => t.metadata.name === "opnsense_manage")!;
  
  if (args[1] === "status") {
    const res = await opnsense.execute(
      { action: "system_status" },
      { toolName: "opnsense_manage", startedAt: Date.now() }
    );
    console.log(formatToolOutput(res, "opnsense_manage"));
    process.exit(res.error ? 1 : 0);
  } else if (args[1] === "aliases") {
    const res = await opnsense.execute(
      { action: "list_aliases" },
      { toolName: "opnsense_manage", startedAt: Date.now() }
    );
    console.log(formatToolOutput(res, "opnsense_manage"));
    process.exit(res.error ? 1 : 0);
  } else {
    console.log("Usage: agent opnsense <status|aliases>");
    process.exit(1);
  }
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
  console.log(formatToolOutput(res, "ssh_execute"));
  process.exit(res.error ? 1 : 0);
} else if (args[0] === "mcp-opnsense") {
  const tools = loadTools();
  const mcpTool = tools.find(t => t.metadata.name === "mcp_opnsense");
  
  if (!mcpTool) {
    console.error("MCP OPNsense tool not available. Check OPNsense environment variables.");
    process.exit(1);
  }
  
  if (args[1] === "modules") {
    // List available modules
    if ("listModules" in mcpTool && typeof mcpTool.listModules === "function") {
      const modules = await (mcpTool as any).listModules();
      console.log("Available modules:");
      for (const [module, count] of Object.entries(modules)) {
        console.log(`  ${module}: ${count} tools`);
      }
    } else {
      console.log("Module listing not available");
    }
    process.exit(0);
  }
  
  if (args.length < 3) {
    console.log("Usage: agent mcp-opnsense <module> <action> [params]");
    console.log("Example: agent mcp-opnsense firewall list_rules");
    console.log("Example: agent mcp-opnsense core system_status");
    console.log("Run 'agent mcp-opnsense modules' to list available modules");
    process.exit(1);
  }
  
  const module = args[1];
  const action = args[2];
  let params = {};
  
  if (args.length > 3) {
    try {
      // Try to parse as JSON if it starts with { or [
      const paramStr = args.slice(3).join(" ");
      if (paramStr.trim().startsWith("{") || paramStr.trim().startsWith("[")) {
        params = JSON.parse(paramStr);
      } else {
        // Otherwise, treat as key=value pairs
        const pairs = paramStr.split(/\s+/);
        for (const pair of pairs) {
          const [key, value] = pair.split("=");
          if (key && value) {
            params[key] = value;
          }
        }
      }
    } catch (e) {
      console.error(`Failed to parse parameters: ${e}`);
      process.exit(1);
    }
  }
  
  const res = await mcpTool.execute(
    { module, action, parameters: params },
    { toolName: "mcp_opnsense", startedAt: Date.now() }
  );
  console.log(formatToolOutput(res, "mcp_opnsense"));
  process.exit(res.error ? 1 : 0);
} else if (args[0] === "proxmox") {
  const tools = loadTools();
  const proxmox = tools.find(t => t.metadata.name === "proxmox_readonly");
  
  if (!proxmox) {
    console.error("Error: proxmox_readonly tool not found");
    process.exit(1);
  }

  // Parse flags
  const flags: Record<string, any> = {};
  const actionArgs: string[] = [];
  
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const [key, value] = arg.substring(2).split("=");
      if (key === "json") {
        flags.json = true;
      } else if (key === "node") {
        flags.node = value || args[++i];
      } else if (key === "vmid") {
        flags.vmid = parseInt(value || args[++i], 10);
      } else if (key === "type") {
        flags.type = value || args[++i];
      }
    } else {
      actionArgs.push(arg);
    }
  }

  // Map CLI subcommands to tool actions
  const actionMap: Record<string, string> = {
    "list-nodes": "list_nodes",
    "node-status": "node_status",
    "node-resources": "node_resources",
    "node-disks": "node_disks",
    "node-network": "node_network_interfaces",
    "list-vms": "list_vms",
    "vm-status": "get_vm_status",
    "vm-config": "get_vm_config",
    "vm-network": "get_vm_network",
    "vm-snapshots": "get_vm_snapshots",
    "cluster-resources": "cluster_resources",
    "cluster-status": "cluster_status",
    "cluster-ceph": "cluster_ceph_status",
    "ha-groups": "ha_groups",
    "ha-resources": "ha_resources",
  };

  if (actionArgs.length === 0 || actionArgs[0] === "help") {
    console.log("Usage: agent proxmox <action> [--node=<node>] [--vmid=<vmid>] [--type=<qemu|lxc>] [--json]");
    console.log("\nActions:");
    console.log("  Node-Level:");
    console.log("    list-nodes              - List all nodes in the cluster");
    console.log("    node-status             - Get node status (requires --node)");
    console.log("    node-resources          - Get node resources (requires --node)");
    console.log("    node-disks              - List node disks (requires --node)");
    console.log("    node-network            - List node network interfaces (requires --node)");
    console.log("  VM-Level:");
    console.log("    list-vms                - List all VMs on a node (requires --node)");
    console.log("    vm-status               - Get VM status (requires --node, --vmid)");
    console.log("    vm-config               - Get VM configuration (requires --node, --vmid)");
    console.log("    vm-network              - Get VM network info (requires --node, --vmid)");
    console.log("    vm-snapshots            - List VM snapshots (requires --node, --vmid)");
    console.log("  Cluster-Level:");
    console.log("    cluster-resources       - Get cluster resources");
    console.log("    cluster-status          - Get cluster status");
    console.log("    cluster-ceph            - Get Ceph status (if configured)");
    console.log("    ha-groups               - List HA groups (if configured)");
    console.log("    ha-resources            - List HA resources (if configured)");
    console.log("\nFlags:");
    console.log("  --node=<node>             - Node name (required for node/VM actions)");
    console.log("  --vmid=<vmid>             - VM ID (required for VM actions)");
    console.log("  --type=<qemu|lxc>         - VM type (default: qemu)");
    console.log("  --json                    - Output raw JSON instead of formatted text");
    console.log("\nExamples:");
    console.log("  agent proxmox list-nodes");
    console.log("  agent proxmox node-status --node=pve1");
    console.log("  agent proxmox list-vms --node=pve1");
    console.log("  agent proxmox vm-status --node=pve1 --vmid=101");
    console.log("  agent proxmox cluster-status");
    process.exit(0);
  }

  const actionName = actionArgs[0];
  const toolAction = actionMap[actionName];

  if (!toolAction) {
    console.error(`Unknown action: ${actionName}`);
    console.log("Run 'agent proxmox help' for usage information");
    process.exit(1);
  }

  // Build parameters
  const params: Record<string, any> = {
    action: toolAction,
  };

  if (flags.node) {
    params.node = flags.node;
  }
  if (flags.vmid) {
    params.vmid = flags.vmid;
  }
  if (flags.type) {
    params.type = flags.type;
  }

  // Execute tool
  const res = await proxmox.execute(
    params,
    { toolName: "proxmox_readonly", startedAt: Date.now() }
  );

  if (res.error) {
    console.error(`❌ Error: ${res.error}`);
    process.exit(1);
  }

  // Format output
  if (flags.json) {
    console.log(JSON.stringify(res.data, null, 2));
  } else {
    const { formatProxmoxOutput } = await import("./tools/proxmox/readonly/cli-formatter");
    console.log(formatProxmoxOutput(res.data, toolAction, { json: false }));
  }

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
  console.log("  pce           - Query the PCE API (Hybrid RAG)");
  console.log("  repl          - Start interactive REPL");
  console.log("  glances       - Test Glances tool directly");
  console.log("  opnsense      - Test OPNsense tool directly");
  console.log("    status      - Get OPNsense system status");
  console.log("    aliases     - List OPNsense firewall aliases");
  console.log("  proxmox       - Test Proxmox tool directly");
  console.log("    <action> [--node=<node>] [--vmid=<vmid>] [--type=<qemu|lxc>] [--json]");
  console.log("    help         - Show Proxmox command help");
  console.log("  ssh           - Test SSH tool directly");
  console.log("    <host> <cmd> - Execute approved SSH command");
  console.log("  mcp-opnsense  - Test MCP OPNsense tool directly");
  console.log("    <module> <action> [params] - Call MCP tool");
  console.log("    modules      - List available modules");
  process.exit(0);
} else {
  console.log(`Unknown command: ${args[0]}`);
  process.exit(1);
}
