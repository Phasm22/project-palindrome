import { BaseTool } from "./BaseTool";
import { SSHToolParams } from "./schemas/ssh";
import type { ExecutionResult, ExecutionContext } from "../types/execution";
import type { ToolSchema } from "./tool-schema";
import { createToolSchema } from "./tool-helpers";
import { logger } from "../utils/logger";
import { loadYaml } from "../utils/config";
import { Client } from "ssh2";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ApprovedCommands {
  hosts: {
    [host: string]: {
      hostname: string;
      aliases?: string[];
      description: string;
      username?: string;
      commands: {
        [category: string]: string[];
      };
      read_only?: boolean;
    };
  };
}

export class SSHTool extends BaseTool {
  private approvedCommands: ApprovedCommands | null = null;

  constructor() {
    super({
      name: "ssh_execute",
      description: "Execute pre-approved read-only SSH commands on lab hosts for filesystem and system analysis",
      categories: ["system", "filesystem"]
    });
  }

  getSchema(): ToolSchema {
    // Load approved commands to get available hosts
    const config = this.loadApprovedCommands();
    const availableHosts: string[] = [];
    
    for (const [hostKey, hostConfig] of Object.entries(config.hosts)) {
      availableHosts.push(hostKey);
      if (hostConfig.aliases) {
        availableHosts.push(...hostConfig.aliases);
      }
    }

    return createToolSchema(this, SSHToolParams, {
      examples: [
        {
          description: "Check disk usage on OPNsense",
          parameters: { host: "opnsense", command: "du -sh /*" }
        },
        {
          description: "List directory sizes in /var",
          parameters: { host: "172.16.0.1", command: "du -sh /var/*", category: "filesystem" }
        }
      ],
      notes: [
        `Available hosts: ${availableHosts.join(", ")}`,
        "Hosts can be specified by IP (e.g., 172.16.0.1) or alias (e.g., opnsense, radar, firewall)",
        "Only pre-approved commands can be executed",
        "If a command fails with 'not approved', the error will suggest similar approved commands",
        "To add new commands, edit src/config/approved-commands.yaml"
      ]
    });
  }

  getParameterSchema() {
    return SSHToolParams;
  }

  private loadApprovedCommands(): ApprovedCommands {
    if (!this.approvedCommands) {
      const configPath = path.join(__dirname, "../config/approved-commands.yaml");
      this.approvedCommands = loadYaml(configPath) as ApprovedCommands;
    }
    return this.approvedCommands!;
  }

  private resolveHost(host: string): string | null {
    const config = this.loadApprovedCommands();
    
    // Direct match
    if (config.hosts[host]) {
      return host;
    }
    
    // Check aliases
    for (const [hostKey, hostConfig] of Object.entries(config.hosts)) {
      if (hostConfig.aliases && hostConfig.aliases.includes(host.toLowerCase())) {
        return hostKey;
      }
    }
    
    return null;
  }

  private getAvailableHosts(): string[] {
    const config = this.loadApprovedCommands();
    const hosts: string[] = [];
    
    for (const [hostKey, hostConfig] of Object.entries(config.hosts)) {
      hosts.push(hostKey);
      if (hostConfig.aliases) {
        hosts.push(...hostConfig.aliases);
      }
    }
    
    return hosts;
  }

  private getAvailableCommands(host: string): string[] {
    const config = this.loadApprovedCommands();
    const resolvedHost = this.resolveHost(host);
    
    if (!resolvedHost) {
      return [];
    }
    
    const hostConfig = config.hosts[resolvedHost];
    const commands: string[] = [];
    
    for (const category of Object.keys(hostConfig.commands)) {
      if (category === "read_only" || typeof hostConfig.commands[category] !== "object") {
        continue;
      }
      const categoryCommands = hostConfig.commands[category];
      const commandList = Array.isArray(categoryCommands) ? categoryCommands : Object.values(categoryCommands);
      commands.push(...commandList);
    }
    
    return commands;
  }

  private isCommandApproved(host: string, command: string): { approved: boolean; reason?: string; suggestions?: string[] } {
    const config = this.loadApprovedCommands();
    const resolvedHost = this.resolveHost(host);

    if (!resolvedHost) {
      const availableHosts = this.getAvailableHosts();
      return { 
        approved: false, 
        reason: `Host "${host}" not found. Available hosts: ${availableHosts.join(", ")}`,
        suggestions: availableHosts
      };
    }
    
    const hostConfig = config.hosts[resolvedHost];

    // Check all command categories
    for (const category of Object.keys(hostConfig.commands)) {
      // Skip non-command properties
      if (category === "read_only" || typeof hostConfig.commands[category] !== "object") {
        continue;
      }
      const commands = hostConfig.commands[category];
      // Handle both array and object formats from YAML
      const commandList = Array.isArray(commands) ? commands : Object.values(commands);
      if (commandList.includes(command)) {
        return { approved: true };
      }
    }

    // Command not approved - provide helpful error with suggestions
    const availableCommands = this.getAvailableCommands(host);
    const commandWords = command.toLowerCase().split(/\s+/);
    
    // Find similar commands
    const suggestions = availableCommands.filter(cmd => {
      const cmdWords = cmd.toLowerCase().split(/\s+/);
      return commandWords.some(word => cmdWords.some(cw => cw.includes(word) || word.includes(cw)));
    }).slice(0, 5);
    
    return { 
      approved: false, 
      reason: `Command "${command}" not approved for host "${host}" (resolved to ${resolvedHost}). Available commands: ${availableCommands.length} total.`,
      suggestions: suggestions.length > 0 ? suggestions : availableCommands.slice(0, 5)
    };
  }

  private async executeSSHCommand(
    host: string,
    command: string,
    username?: string,
    privateKey?: string,
    password?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let stdout = "";
      let stderr = "";
      let shellStream: any = null;
      let commandExecuted = false;

      conn.on("ready", () => {
        // OPNsense uses an interactive shell with a menu
        // We need to start a shell session and select option 8 (shell)
        conn.shell((err, stream) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }

          shellStream = stream;
          let menuBuffer = "";
          let shellReady = false;

          stream.on("data", (data: Buffer) => {
            const text = data.toString();
            menuBuffer += text;

            // Check if we're at the OPNsense menu (look for menu indicators)
            if (!shellReady && (text.includes("Enter an option") || text.includes("8) Shell"))) {
              // Send "8" to select shell option
              logger.info("OPNsense menu detected, selecting shell (option 8)");
              stream.write("8\n");
              shellReady = true;
              return;
            }

            // Once in shell, wait for prompt then execute command
            if (shellReady && !commandExecuted) {
              // Look for shell prompt (root@OPNsense:~ # or similar)
              if (text.match(/root@.*[#>$]\s*$/m) || text.includes("~ #") || text.includes("~ $")) {
                commandExecuted = true;
                logger.info(`Executing command in shell: ${command}`);
                stream.write(`${command}\n`);
                // Set a timeout to exit if no more output
                setTimeout(() => {
                  stream.write("exit\n");
                  setTimeout(() => {
                    stream.end();
                  }, 500);
                }, 2000); // Wait 2 seconds for command output
                return;
              }
            }

            // Collect command output
            if (commandExecuted) {
              // Filter out menu text, prompts, and the command echo
              const lines = text.split("\n");
              for (const line of lines) {
                const cleanLine = line.replace(/\r/g, "").trim();
                // Skip menu text, prompts, command echo, and empty lines
                if (
                  cleanLine.length > 0 &&
                  !cleanLine.includes("Enter an option") &&
                  !cleanLine.includes("OPNsense") &&
                  !cleanLine.match(/^\d+\)\s+/) &&
                  !cleanLine.match(/^root@.*[#>$]\s*$/) &&
                  !cleanLine.match(/^.*[#>$]\s*$/) &&
                  cleanLine !== command.trim() &&
                  cleanLine !== "exit" &&
                  !cleanLine.match(/^HomeNetwork|^LabNetwork|^securityLab|^HTTPS:|^SSH:/) &&
                  !cleanLine.match(/^SHA256/) &&
                  !cleanLine.match(/^[A-F0-9]{2}(\s+[A-F0-9]{2}){15}$/) && // Skip hex fingerprints
                  !cleanLine.match(/^[a-f0-9]{64}$/) // Skip full SHA256 hashes
                ) {
                  stdout += cleanLine + "\n";
                }
              }
            }
          });

          stream.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
          });

          // Add timeout to prevent hanging
          const timeout = setTimeout(() => {
            // If we have output, the command likely succeeded - just close cleanly
            if (stdout.trim().length > 0) {
              logger.info("SSH command completed (timeout reached but output received)");
            } else {
              logger.error("SSH command timeout - no output received");
            }
            stream.end();
            conn.end();
            resolve({ 
              stdout: stdout || "Command executed but no output received", 
              stderr, 
              exitCode: 0 
            });
          }, 10000); // 10 second timeout

          stream.on("close", () => {
            clearTimeout(timeout);
            conn.end();
            // Clean up output - remove empty lines and trim
            const outputLines = stdout.split("\n")
              .filter(line => line.trim().length > 0)
              .filter(line => 
                !line.includes("Enter an option") &&
                !line.includes("OPNsense") &&
                !line.match(/^\d+\.\s+/) &&
                !line.match(/^root@.*[#>$]\s*$/) &&
                !line.match(/^.*[#>$]\s*$/)
              );
            
            const commandOutput = outputLines.join("\n").trim();
            
            resolve({ 
              stdout: commandOutput || stdout, 
              stderr, 
              exitCode: 0 
            });
          });
        });
      });

      conn.on("error", (err) => {
        reject(err);
      });

      // Connection options
      const connectOptions: any = {
        host,
        port: 22,
        readyTimeout: 10000,
        username: username || "root",
      };

      // Use SSH key if provided
      if (privateKey) {
        connectOptions.privateKey = privateKey;
      } else if (password) {
        // Use password authentication
        connectOptions.password = password;
      } else {
        // Default: try to use SSH key from ~/.ssh/id_rsa or environment
        const sshKeyPath = process.env.SSH_KEY_PATH || path.join(process.env.HOME || "~", ".ssh/id_rsa");
        try {
          const fs = require("fs");
          if (fs.existsSync(sshKeyPath)) {
            connectOptions.privateKey = fs.readFileSync(sshKeyPath);
          }
        } catch (e) {
          // Ignore
        }
      }

      conn.connect(connectOptions);
    });
  }

  async execute(
    params: Record<string, any>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const parsed = SSHToolParams.safeParse(params);
    if (!parsed.success) {
      return { error: parsed.error.message };
    }

    const started = context.startedAt ?? Date.now();
    const { host, command } = parsed.data;

    // Validate command is approved
    const approval = this.isCommandApproved(host, command);
    if (!approval.approved) {
      let errorMessage = approval.reason || "Command not approved";
      
      // Add suggestions if available
      if (approval.suggestions && approval.suggestions.length > 0) {
        errorMessage += `\n\nSuggested approved commands:\n${approval.suggestions.map(cmd => `  - ${cmd}`).join("\n")}`;
      }
      
      // Add hint about adding commands
      errorMessage += `\n\nTo use this command, add it to src/config/approved-commands.yaml for host "${host}"`;
      
      return {
        error: errorMessage,
        durationMs: Date.now() - started,
      };
    }
    
    // Resolve host alias to actual hostname
    const resolvedHost = this.resolveHost(host);
    if (!resolvedHost) {
      return {
        error: `Could not resolve host "${host}"`,
        durationMs: Date.now() - started,
      };
    }

    try {
      logger.info(`Executing approved SSH command on ${resolvedHost} (requested as ${host}): ${command}`);

      // Get SSH credentials from config first, then environment (use resolved host for env vars)
      const config = this.loadApprovedCommands();
      const hostConfig = config.hosts[resolvedHost];
      const envHostKey = resolvedHost.replace(/\./g, "_");
      let username = hostConfig?.username || process.env[`SSH_USER_${envHostKey}`] || process.env.SSH_USER || "root";
      let password = process.env[`SSH_PASSWORD_${envHostKey}`] || process.env.SSH_PASSWORD;
      const privateKey = process.env[`SSH_KEY_${envHostKey}`];

      // Remove quotes if present (dotenv might preserve them)
      if (username) username = username.replace(/^["']|["']$/g, "");
      if (password) password = password.replace(/^["']|["']$/g, "");

      logger.info(`SSH auth: user=${username}, hasPassword=${!!password}, hasKey=${!!privateKey}`);

      const result = await this.executeSSHCommand(resolvedHost, command, username, privateKey, password);

      if (result.exitCode !== 0) {
        return {
          error: `Command failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
          durationMs: Date.now() - started,
        };
      }

      return {
        data: {
          host: resolvedHost,
          requestedHost: host,
          command,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
        durationMs: Date.now() - started,
      };
    } catch (err: any) {
      const errorMessage = err.message || "SSH command execution failed";
      logger.error(`SSH error: ${errorMessage}`);
      return {
        error: errorMessage,
        durationMs: Date.now() - started,
      };
    }
  }
}

