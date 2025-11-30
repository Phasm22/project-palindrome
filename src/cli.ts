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
import { executeToolCall } from "./agent/tool-executor";
import {
  getToolRisk,
  isToolAuthorized,
  requiresConfirmation,
  type ToolSession,
} from "./agent/tool-policy";
import { sanitizeToolPayload } from "./agent/tool-sanitizer";
import type { BaseTool } from "./tools/BaseTool";

type ConfirmHighRiskFn = (info: { toolName: string; parameters: Record<string, any>; risk: string }) => Promise<boolean>;

function getCliSession(): ToolSession {
  return {
    userId: process.env.PCE_USER_ID || "cli-user",
    aclGroup: process.env.PCE_ACL_GROUP || "admin",
  };
}

async function confirmHighRiskPrompt(
  info: { toolName: string; parameters: Record<string, any>; risk: string },
  { autoApprove }: { autoApprove?: boolean } = {}
): Promise<boolean> {
  if (autoApprove || process.env.PCE_AUTO_APPROVE_HIGH_RISK_TOOLS === "true") {
    return true;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("\n❌ Cannot prompt for confirmation in non-interactive mode.");
    console.error("   Use --yes flag or set PCE_AUTO_APPROVE_HIGH_RISK_TOOLS=true to auto-approve.\n");
    return false;
  }

  return await new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

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
}

async function executeWithPolicies(
  toolName: string,
  parameters: Record<string, any>,
  tools: BaseTool[],
  options: { confirmHighRisk?: ConfirmHighRiskFn; session?: ToolSession } = {}
): Promise<ExecutionResult> {
  const tool = tools.find((t) => t.metadata.name === toolName);

  if (!tool) {
    return { error: `Tool not registered: ${toolName}` };
  }

  const session = options.session ?? getCliSession();
  if (!isToolAuthorized(tool, session)) {
    return { error: `ACL group ${session.aclGroup} is not authorized to run ${toolName}` };
  }

  if (requiresConfirmation(tool)) {
    const approved = await (options.confirmHighRisk ?? confirmHighRiskPrompt)({
      toolName,
      parameters,
      risk: getToolRisk(tool),
    });

    if (!approved) {
      return { error: "High-risk action was not approved" };
    }
  }

  const execContext = {
    userId: session.userId,
    aclGroup: session.aclGroup,
    node: parameters.node || parameters.host,
    vmid: typeof parameters.vmid === "number" ? parameters.vmid : undefined,
  };
  const result = await executeToolCall({ toolName, parameters }, tools, execContext);
  return { ...result, data: sanitizeToolPayload(result.data) };
}

/**
 * Formats tool execution results for user-friendly CLI output
 */
/**
 * Handle streaming agent events for CLI output
 */
function handleStreamEvent(event: any): void {
  switch (event.type) {
    case "agent:step":
      console.log(`\n[Step ${event.data.step}/${event.data.maxSteps}]`);
      break;
      
    case "tool:start":
      console.log(`\n🔧 Executing: ${event.data.toolName}`);
      if (event.data.parameters) {
        const params = Object.entries(event.data.parameters)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join(", ");
        if (params) console.log(`   Parameters: ${params}`);
      }
      break;
      
    case "tool:complete":
      if (event.data.success) {
        console.log(`✅ ${event.data.toolName} completed (${event.data.durationMs}ms)`);
      } else {
        console.log(`❌ ${event.data.toolName} failed: ${event.data.error}`);
      }
      break;
      
    case "agent:final":
      // Final response will be printed after stream closes
      break;
      
    default:
      // Ignore other event types
      break;
  }
}

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
          .filter((line: string) => {
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
    case "opnsense_readonly":
    case "opnsense_safewrite":
      // For OPNsense, show formatted JSON (it's usually structured data)
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
} else if (args[0] === "ask" || args[0] === "pce") {
  // Unified agent mode: uses PCE (Hybrid RAG) by default
  // "ask" and "pce" are now aliases - both use the same functionality
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
    console.log(`Usage: agent ${args[0]} [--yes|--auto-approve] [--stream] "your question"`);
    console.log("\nFlags:");
    console.log("  --yes, --auto-approve    Auto-approve high-risk operations (write actions)");
    console.log("  --stream                 Stream events in real-time via SSE");
    process.exit(1);
  }

  try {
    const userId = process.env.PCE_USER_ID || "default-user";
    const aclGroup = process.env.PCE_ACL_GROUP || "viewer";
    const useStream = flags.stream || process.env.PCE_STREAM === "true";
    const autoApprove = flags.yes || flags["auto-approve"] || process.env.PCE_AUTO_APPROVE_HIGH_RISK_TOOLS === "true";
    
    const confirmHighRisk = async (info: { toolName: string; parameters: Record<string, any>; risk: string }): Promise<boolean> => {
      if (autoApprove) {
        console.log(`\n⚠️  Auto-approving ${info.risk}-risk operation: ${info.toolName}`);
        console.log(`   Parameters: ${JSON.stringify(info.parameters, null, 2)}\n`);
        return true;
      }
      return confirmHighRiskPrompt(info);
    };
    
    if (useStream) {
      const apiUrl = process.env.PCE_API_URL || "http://localhost:4000";
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      
      const agentPromise = runAgent(prompt, {
        userId,
        aclGroup,
        ragBaseUrl: apiUrl,
        confirmHighRisk,
        sessionId,
      });
      
      const eventSource = new EventSource(`${apiUrl}/api/agent/stream?sessionId=${sessionId}`);
      
      eventSource.onmessage = (event) => {
        try {
          const agentEvent = JSON.parse(event.data);
          handleStreamEvent(agentEvent);
        } catch (error: any) {
          console.error("Error parsing SSE event:", error.message);
        }
      };
      
      eventSource.onerror = (error) => {
        console.error("SSE connection error:", error);
        eventSource.close();
      };
      
      const response = await agentPromise;
      await new Promise(resolve => setTimeout(resolve, 500));
      eventSource.close();
      
      if (response.text) {
        console.log("\n" + response.text);
      }
    } else {
      const response = await runAgent(prompt, {
        userId,
        aclGroup,
        ragBaseUrl: process.env.PCE_API_URL || "http://localhost:4000",
        confirmHighRisk,
      });
      
      console.log(response.text);
    }
    
    process.exit(0);
  } catch (error: any) {
    console.error("Error:", error.message);
    process.exit(1);
  }
} else if (args[0] === "pce-api") {
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
    console.log("Usage: agent pce [--yes|--auto-approve] [--stream] \"your question\"");
    console.log("\nFlags:");
    console.log("  --yes, --auto-approve    Auto-approve high-risk operations (write actions)");
    console.log("  --stream                 Stream events in real-time via SSE");
    process.exit(1);
  }

  try {
    // Use runAgent directly to enable tool calling (TL-1C)
    // This allows the LLM to autonomously select and execute OPNsense tools
    const userId = process.env.PCE_USER_ID || "default-user";
    const aclGroup = process.env.PCE_ACL_GROUP || "viewer";
    const useStream = flags.stream || process.env.PCE_STREAM === "true";
    
    // Handle confirmation for write operations
    const autoApprove = flags.yes || flags["auto-approve"] || process.env.PCE_AUTO_APPROVE_HIGH_RISK_TOOLS === "true";
    
    const confirmHighRisk = async (info: { toolName: string; parameters: Record<string, any>; risk: string }): Promise<boolean> => {
      if (autoApprove) {
        console.log(`\n⚠️  Auto-approving ${info.risk}-risk operation: ${info.toolName}`);
        console.log(`   Parameters: ${JSON.stringify(info.parameters, null, 2)}\n`);
        return true;
      }

      return confirmHighRiskPrompt(info);
    };
    
    if (useStream) {
      // Streaming mode: Start agent and consume SSE events
      const apiUrl = process.env.PCE_API_URL || "http://localhost:4000";
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      
      // Start agent in background
      const agentPromise = runAgent(prompt, {
        userId,
        aclGroup,
        ragBaseUrl: apiUrl,
        confirmHighRisk,
        sessionId,
      });
      
      // Connect to SSE stream
      const eventSource = new EventSource(`${apiUrl}/api/agent/stream?sessionId=${sessionId}`);
      
      eventSource.onmessage = (event) => {
        try {
          const agentEvent = JSON.parse(event.data);
          handleStreamEvent(agentEvent);
        } catch (error: any) {
          console.error("Error parsing SSE event:", error.message);
        }
      };
      
      eventSource.onerror = (error) => {
        console.error("SSE connection error:", error);
        eventSource.close();
      };
      
      // Wait for agent to complete
      const response = await agentPromise;
      
      // Give SSE a moment to flush final events
      await new Promise(resolve => setTimeout(resolve, 500));
      eventSource.close();
      
      if (response.text) {
        console.log("\n" + response.text);
      }
    } else {
      // Non-streaming mode: traditional execution
      const response = await runAgent(prompt, {
        userId,
        aclGroup,
        ragBaseUrl: process.env.PCE_API_URL || "http://localhost:4000",
        confirmHighRisk,
      });
      
      console.log(response.text);
    }
    
    process.exit(0);
  } catch (error: any) {
    console.error("Error:", error.message);
    process.exit(1);
  }
} else if (args[0] === "pce-api") {
  // DEPRECATED: Use "agent ask" or "agent pce" instead (both now use PCE with tool calling)
  // Legacy API-only mode (RAG only, no tool calling) - kept for backward compatibility
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

  if (args[1] === "status") {
    const res = await executeWithPolicies(
      "opnsense_readonly",
      { action: "system_status" },
      tools
    );
    console.log(formatToolOutput(res, "opnsense_readonly"));
    process.exit(res.error ? 1 : 0);
  } else if (args[1] === "aliases") {
    const res = await executeWithPolicies(
      "opnsense_readonly",
      { action: "firewall_aliases_list" },
      tools
    );
    console.log(formatToolOutput(res, "opnsense_readonly"));
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

  const res = await executeWithPolicies(
    "ssh_execute",
    { host, command },
    tools
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
  let params: Record<string, any> = {};
  
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
  
  const res = await executeWithPolicies(
    "mcp_opnsense",
    { module, action, parameters: params },
    tools
  );
  console.log(formatToolOutput(res, "mcp_opnsense"));
  process.exit(res.error ? 1 : 0);
} else if (args[0] === "proxmox") {
  const tools = loadTools();
  const proxmoxReadonly = tools.find((t) => t.metadata.name === "proxmox_readonly");
  const proxmoxWrite = tools.find((t) => t.metadata.name === "proxmox_write");

  if (!proxmoxReadonly) {
    console.error("Error: proxmox_readonly tool not found");
    process.exit(1);
  }
  if (!proxmoxWrite) {
    console.error("Error: proxmox_write tool not found");
    process.exit(1);
  }

  type ProxmoxFlags = { json?: boolean; node?: string; vmid?: number; type?: string };
  const flags: ProxmoxFlags = {};
  const actionArgs: string[] = [];

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string") {
      continue;
    }
    if (arg.startsWith("--")) {
      const [key, rawValue] = arg.substring(2).split("=");
      if (key === "json") {
        flags.json = true;
      } else if (key === "node") {
        if (rawValue) {
          flags.node = rawValue;
        } else if (i + 1 < args.length && typeof args[i + 1] === "string" && !args[i + 1].startsWith("--")) {
          flags.node = args[++i];
        } else {
          console.error("--node flag requires a value");
          process.exit(1);
        }
      } else if (key === "vmid") {
        let vmidValue: string;
        if (rawValue) {
          vmidValue = rawValue;
        } else if (i + 1 < args.length && typeof args[i + 1] === "string" && !args[i + 1].startsWith("--")) {
          vmidValue = args[++i];
        } else {
          console.error("--vmid flag requires a value");
          process.exit(1);
        }
        const parsed = Number(vmidValue);
        if (Number.isNaN(parsed)) {
          console.error(`Invalid vmid '${vmidValue}'`);
          process.exit(1);
        }
        flags.vmid = parsed;
      } else if (key === "type") {
        if (rawValue) {
          flags.type = rawValue;
        } else if (i + 1 < args.length && typeof args[i + 1] === "string" && !args[i + 1].startsWith("--")) {
          flags.type = args[++i];
        } else {
          console.error("--type flag requires a value");
          process.exit(1);
        }
      }
    } else {
      actionArgs.push(arg);
    }
  }

  const writeActions: Record<string, { action: string; defaultType?: "qemu" | "lxc" }> = {
    "start-vm": { action: "start_vm", defaultType: "qemu" },
    "stop-vm": { action: "stop_vm", defaultType: "qemu" },
    "reset-vm": { action: "reset_vm", defaultType: "qemu" },
    "shutdown-vm": { action: "shutdown_vm", defaultType: "qemu" },
    "migrate-vm": { action: "migrate_vm", defaultType: "qemu" },
    "destroy-vm": { action: "destroy_vm", defaultType: "qemu" },
  };

  const readonlyActions: Record<string, string> = {
    "list-nodes": "list_nodes",
    "node-status": "node_status",
    "node-storage": "node_storage",
    "node-services": "node_services",
    "node-tasks": "node_tasks",
    "node-disks": "node_disks",
    "node-network": "node_network_interfaces",
    "version": "get_version",
    "list-vms": "list_vms",
    "vm-status": "get_vm_status",
    "vm-config": "get_vm_config",
    "vm-network": "get_vm_network",
    "vm-snapshots": "get_vm_snapshots",
    "get-vm-ip": "get_vm_ip",
    "vm-ip": "get_vm_ip", // Alias for convenience
    "cluster-resources": "cluster_resources",
    "cluster-status": "cluster_status",
    "cluster-ceph": "cluster_ceph_status",
    "ha-groups": "ha_groups",
    "ha-resources": "ha_resources",
  };

  const printProxmoxHelp = (): void => {
    console.log("Usage: agent proxmox <action> [--node=<node>] [--vmid=<vmid>] [--type=<qemu|lxc>] [--json]");
    console.log("\nActions:");
    console.log("  Node-Level:");
    console.log("    list-nodes              - List all nodes in the cluster");
    console.log("    node-status             - Get node status (requires --node)");
    console.log("    node-resources          - Get node resources (requires --node)");
    console.log("    node-disks              - List node disks (requires --node)");
    console.log("    node-network            - List node network interfaces (requires --node)");
    console.log("  VM-Level (read-only):");
    console.log("    list-vms                - List all VMs on a node (requires --node)");
    console.log("    vm-status               - Get VM status (requires --node, --vmid)");
    console.log("    vm-config               - Get VM configuration (requires --node, --vmid)");
    console.log("    vm-network              - Get VM network info (requires --node, --vmid)");
    console.log("    vm-snapshots            - List VM snapshots (requires --node, --vmid)");
    console.log("    get-vm-ip               - Get VM IP address (requires --node, --vmid, optional --type)");
    console.log("    vm-ip                   - Alias for get-vm-ip");
    console.log("  VM-Level (write actions):");
    console.log("    start-vm                - Start a VM (requires --node, --vmid, optional --type)");
    console.log("    stop-vm                 - Stop a VM (requires --node, --vmid, optional --type)");
    console.log("    reset-vm                - Reset a VM (requires --node, --vmid, optional --type)");
    console.log("    shutdown-vm             - Shutdown a VM (requires --node, --vmid, optional --type)");
    console.log("    migrate-vm              - Migrate a VM (requires --node, --vmid, optional --type)");
    console.log("    destroy-vm             - Permanently destroy a VM/container (EXTREME RISK - requires --node, --vmid, optional --type)");
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
    console.log("  agent proxmox list-vms --node=yin");
    console.log("  agent proxmox start-vm --node=YANG --vmid=105 --type=lxc");
    console.log("  agent proxmox vm-status --node=yin --vmid=200");
    console.log("  agent proxmox get-vm-ip --node=proxBig --vmid=100");
    console.log("  agent proxmox cluster-status");
  };

  if (actionArgs.length === 0 || actionArgs[0] === "help") {
    printProxmoxHelp();
    process.exit(0);
  }

  const actionName = actionArgs[0];
  if (!actionName) {
    console.error("No action specified");
    printProxmoxHelp();
    process.exit(1);
  }

  const writeAction = writeActions[actionName];

  if (writeAction) {
    if (!flags.node) {
      console.error(`${actionName} requires --node=<node>`);
      process.exit(1);
    }
    if (typeof flags.vmid !== "number" || Number.isNaN(flags.vmid)) {
      console.error(`${actionName} requires --vmid=<vmid>`);
      process.exit(1);
    }

    const writeParams: Record<string, any> = {
      action: writeAction.action,
      node: flags.node,
      vmid: flags.vmid,
      type: flags.type || writeAction.defaultType || "qemu",
    };

    const writeResult = await executeWithPolicies("proxmox_write", writeParams, tools);
    if (writeResult.error) {
      console.error(`❌ Error: ${writeResult.error}`);
      process.exit(1);
    }

    if (flags.json) {
      console.log(JSON.stringify(writeResult.data ?? { success: true }, null, 2));
    } else {
      console.log("✅ Proxmox action completed successfully");
    }

    process.exit(0);
  }

  const readonlyAction = readonlyActions[actionName];
  if (!readonlyAction) {
    console.error(`❌ Unknown action: ${actionName}`);
    console.error(`\nAvailable actions:`);
    console.error(`  Read-only: ${Object.keys(readonlyActions).join(", ")}`);
    console.error(`  Write: ${Object.keys(writeActions).join(", ")}`);
    console.error(`\nUse 'agent proxmox help' for full documentation.`);
    printProxmoxHelp();
    process.exit(1);
  }

  const readonlyParams: Record<string, any> = { action: readonlyAction };
  if (flags.node) readonlyParams.node = flags.node;
  if (typeof flags.vmid === "number" && !Number.isNaN(flags.vmid)) {
    readonlyParams.vmid = flags.vmid;
  }
  if (flags.type) readonlyParams.type = flags.type;

  const readonlyResult = await executeWithPolicies("proxmox_readonly", readonlyParams, tools);
  if (readonlyResult.error) {
    console.error(`❌ Error: ${readonlyResult.error}`);
    process.exit(1);
  }

  if (flags.json) {
    console.log(JSON.stringify(readonlyResult.data, null, 2));
  } else {
    const { formatProxmoxOutput } = await import("./tools/proxmox/readonly/cli-formatter");
    console.log(formatProxmoxOutput(readonlyResult.data, readonlyAction, { json: false }));
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
  console.log("  ask           - Ask the agent a question (uses PCE/Hybrid RAG)");
  console.log("  pce           - Alias for 'ask' (uses PCE/Hybrid RAG)");
  console.log("  pce-api       - DEPRECATED: Legacy RAG-only mode (use 'ask' instead)");
  console.log("  repl          - Start interactive REPL");
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
