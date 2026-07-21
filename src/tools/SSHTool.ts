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
import { execFile, spawn as spawnChild } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

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
      // Some older network gear (e.g. Cisco IOS switches from ~2010s) only
      // offers SSH KEX/cipher algorithms modern clients disable by default.
      // Set true to opt that specific host into a legacy-compatible algorithm
      // list instead of weakening defaults for every host.
      legacy_ssh?: boolean;
    };
  };
}

interface SSHConnection {
  client: Client;
  host: string;
  lastUsed: number;
  inUse: boolean;
}

class SSHConnectionPool {
  private connections: Map<string, SSHConnection> = new Map();
  private maxIdleTime = 30000; // 30 seconds
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Clean up idle connections every 10 seconds. unref() so this recurring
    // timer never keeps a process alive on its own — a one-shot script
    // (ingest-all, ingest-switches, ...) that only ever touches SSHTool
    // should still be able to exit naturally once its real work is done,
    // instead of hanging forever waiting on housekeeping.
    this.cleanupInterval = setInterval(() => this.cleanupIdle(), 10000);
    this.cleanupInterval.unref?.();
  }

  private isClientDestroyed(client: Client): boolean {
    const candidate = client as unknown as {
      destroyed?: boolean;
      _sock?: { destroyed?: boolean };
    };
    return candidate.destroyed === true || candidate._sock?.destroyed === true;
  }

  private cleanupIdle() {
    const now = Date.now();
    for (const [key, conn] of this.connections.entries()) {
      if (!conn.inUse && (now - conn.lastUsed) > this.maxIdleTime) {
        logger.debug(`Closing idle SSH connection to ${conn.host}`);
        conn.client.end();
        this.connections.delete(key);
      }
    }
  }

  async getConnection(
    host: string,
    username?: string,
    privateKey?: string,
    password?: string
  ): Promise<Client> {
    const key = `${host}:${username || 'root'}`;
    let conn = this.connections.get(key);

    // Reuse existing connection if available and not in use
    if (conn && !conn.inUse) {
      // Check if connection is still alive
      if (conn.client && !this.isClientDestroyed(conn.client)) {
        conn.lastUsed = Date.now();
        conn.inUse = true;
        return conn.client;
      } else {
        // Connection is dead, remove it
        this.connections.delete(key);
      }
    }

    // Create new connection
    const client = new Client();
    const newConn: SSHConnection = {
      client,
      host,
      lastUsed: Date.now(),
      inUse: true,
    };

    return new Promise((resolve, reject) => {
      const connectOptions: any = {
        host,
        port: 22,
        readyTimeout: 10000,
        username: username || "root",
      };

      if (privateKey) {
        connectOptions.privateKey = privateKey;
      } else if (password) {
        connectOptions.password = password;
      } else {
        const sshKeyPath = process.env.SSH_KEY_PATH || path.join(process.env.HOME || "~", ".ssh/id_ed25519");
        try {
          const fs = require("fs");
          if (fs.existsSync(sshKeyPath)) {
            connectOptions.privateKey = fs.readFileSync(sshKeyPath);
          } else {
            // Fallback to id_rsa
            const fallbackKeyPath = path.join(process.env.HOME || "~", ".ssh/id_rsa");
            if (fs.existsSync(fallbackKeyPath)) {
              connectOptions.privateKey = fs.readFileSync(fallbackKeyPath);
            }
          }
        } catch (e) {
          // Ignore
        }
      }

      client.on("ready", () => {
        this.connections.set(key, newConn);
        resolve(client);
      });

      client.on("error", (err) => {
        // Don't store failed connections
        reject(err);
      });

      client.on("close", () => {
        // Remove from pool when connection closes
        if (this.connections.get(key) === newConn) {
          this.connections.delete(key);
        }
      });

      client.connect(connectOptions);
    });
  }

  releaseConnection(host: string, username?: string) {
    const key = `${host}:${username || 'root'}`;
    const conn = this.connections.get(key);
    if (conn) {
      conn.inUse = false;
      conn.lastUsed = Date.now();
    }
  }

  closeAll() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    for (const conn of this.connections.values()) {
      conn.client.end();
    }
    this.connections.clear();
  }
}

// Global connection pool
const sshPool = new SSHConnectionPool();

export class SSHTool extends BaseTool {
  private approvedCommands: ApprovedCommands | null = null;

  constructor() {
    super({
      name: "ssh_execute",
      description: "Execute pre-approved read-only SSH commands on lab hosts for filesystem and system analysis",
      categories: ["system", "filesystem"]
    });
  }

  override getSchema(): ToolSchema {
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

  override getParameterSchema() {
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

  /**
   * Convert temperature values from Celsius to Fahrenheit
   * Supports both human-readable and JSON formats from sensors command
   */
  private convertTemperatureToFahrenheit(output: string, isJson: boolean): string {
    if (isJson) {
      // Parse JSON and convert temperature values
      try {
        const data = JSON.parse(output);
        const converted = this.convertJsonTemperatures(data);
        return JSON.stringify(converted, null, 2);
      } catch (e) {
        // If JSON parsing fails, fall back to text conversion
        return this.convertTextTemperatures(output);
      }
    } else {
      // Convert human-readable format
      return this.convertTextTemperatures(output);
    }
  }

  /**
   * Convert temperatures in JSON format (sensors -j)
   */
  private convertJsonTemperatures(data: any): any {
    if (typeof data === "object" && data !== null) {
      if (Array.isArray(data)) {
        return data.map(item => this.convertJsonTemperatures(item));
      }
      
      const converted: any = {};
      for (const [key, value] of Object.entries(data)) {
        if (key === "temp" || key === "temp_input" || key === "temp_max" || key === "temp_crit") {
          // Temperature value - convert if it's a number
          if (typeof value === "number") {
            converted[key] = this.celsiusToFahrenheit(value);
            converted[`${key}_celsius`] = value; // Keep original in case needed
          } else if (typeof value === "object" && value !== null) {
            // Nested temperature object
            converted[key] = this.convertJsonTemperatures(value);
          } else {
            converted[key] = value;
          }
        } else if (typeof value === "object" && value !== null) {
          converted[key] = this.convertJsonTemperatures(value);
        } else {
          converted[key] = value;
        }
      }
      return converted;
    }
    return data;
  }

  /**
   * Convert temperatures in human-readable text format (sensors)
   */
  private convertTextTemperatures(output: string): string {
    // Pattern to match temperature values like: +45.0°C, 45.0°C, -10.0°C
    // Also matches ranges like: (high = +80.0°C, crit = +100.0°C)
    const tempPattern = /([+-]?\d+\.?\d*)\s*°C/g;
    
    return output.replace(tempPattern, (match, celsiusStr) => {
      const celsius = parseFloat(celsiusStr);
      if (isNaN(celsius)) return match;
      
      const fahrenheit = this.celsiusToFahrenheit(celsius);
      // Show Fahrenheit as primary, with Celsius in parentheses
      const fahrenheitStr = fahrenheit >= 0 ? `+${fahrenheit.toFixed(1)}` : `${fahrenheit.toFixed(1)}`;
      return `${fahrenheitStr}°F (${match})`;
    });
  }

  /**
   * Convert Celsius to Fahrenheit
   */
  private celsiusToFahrenheit(celsius: number): number {
    return (celsius * 9/5) + 32;
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
    if (!hostConfig) {
      return [];
    }
    const commands: string[] = [];
    
    for (const category of Object.keys(hostConfig.commands)) {
      if (category === "read_only" || typeof hostConfig.commands[category] !== "object") {
        continue;
      }
      const categoryCommands = hostConfig.commands[category];
      const commandList = (Array.isArray(categoryCommands)
        ? categoryCommands
        : Object.values(categoryCommands)
      ).filter((item): item is string => typeof item === "string");
      commands.push(...commandList);
    }
    
    return commands;
  }

  /**
   * Expand common command aliases to their full forms
   * e.g., "ip addr" -> "ip addr show", "ip link" -> "ip link show"
   */
  private expandCommandAlias(command: string): string[] {
    const expansions: string[] = [command]; // Always include original
    
    // Common ip command aliases
    const ipAliases: Record<string, string> = {
      "ip addr": "ip addr show",
      "ip link": "ip link show",
      "ip route": "ip route show",
      "ip a": "ip addr show",
      "ip l": "ip link show",
      "ip r": "ip route show",
    };
    
    if (ipAliases[command]) {
      expansions.push(ipAliases[command]);
    }
    
    return expansions;
  }

  /**
   * Check if a command matches a template with placeholders
   * Example: "pvesh get /nodes/yin/qemu" matches "pvesh get /nodes/{node}/qemu"
   */
  private matchesPlaceholderTemplate(actualCommand: string, template: string): boolean {
    // If template has no placeholders, skip (already checked exact match)
    if (!template.includes("{") || !template.includes("}")) {
      return false;
    }

    // Build regex pattern: escape the template first, then replace {placeholder} with (.+)
    // Step 1: Escape all special regex characters
    let regexPattern = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    
    // Step 2: Replace escaped \{placeholder\} with (.+)
    regexPattern = regexPattern.replace(/\\\{[^}]+\\\}/g, "(.+)");

    // Test if actual command matches the pattern
    try {
      const regex = new RegExp("^" + regexPattern + "$");
      return regex.test(actualCommand);
    } catch (error) {
      // If regex construction fails, fall back to false
      return false;
    }
  }

  private isCommandApproved(host: string, command: string): { approved: boolean; reason?: string; suggestions?: string[]; expandedCommand?: string } {
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
    if (!hostConfig) {
      return {
        approved: false,
        reason: `Host "${host}" resolved to "${resolvedHost}" but has no configuration.`,
      };
    }

    // Try command aliases/expansions first
    const commandExpansions = this.expandCommandAlias(command);
    for (const expandedCmd of commandExpansions) {
      // Check all command categories
      for (const category of Object.keys(hostConfig.commands)) {
        // Skip non-command properties
        if (category === "read_only" || typeof hostConfig.commands[category] !== "object") {
          continue;
        }
        const commands = hostConfig.commands[category];
        // Handle both array and object formats from YAML
        const commandList = (Array.isArray(commands) ? commands : Object.values(commands)).filter(
          (item): item is string => typeof item === "string"
        );
        
        // First try exact match
        if (commandList.includes(expandedCmd)) {
          // If we used an expansion, return the expanded command
          if (expandedCmd !== command) {
            return { approved: true, expandedCommand: expandedCmd };
          }
          return { approved: true };
        }
        
        // Then try placeholder matching (e.g., {node} -> yin, yang, proxBig, etc.)
        for (const approvedCmd of commandList) {
          if (this.matchesPlaceholderTemplate(expandedCmd, approvedCmd)) {
            return { approved: true, expandedCommand: expandedCmd };
          }
        }
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

  /**
   * Cisco IOS's non-interactive SSH exec ("ssh user@host 'command'") only
   * accepts a limited set of commands on this switch — anything requiring
   * privileged EXEC (show running-config, dir flash:, show boot, ...) fails
   * with "Line has invalid autocommand" because there's no way to answer
   * the `enable` password prompt inside a single one-shot request. This
   * drives a real interactive session instead: login (via sshpass), send
   * `enable`, answer its password prompt, disable pagination, then run the
   * actual command and capture output up to the next prompt.
   *
   * IMPORTANT: send bare `\r`, not `\r\n`, for each line. Sending `\r\n` on
   * this device's PTY was observed to register as two Enter presses — the
   * second one silently submits an empty response to whatever prompt comes
   * next (e.g. an empty enable password), which reads exactly like a wrong
   * password ("% Access denied") even though the real password was never
   * actually sent yet. Cost real time to track down; don't reintroduce it.
   */
  private async executeLegacyInteractiveSSHCommand(
    host: string,
    command: string,
    username: string,
    password: string,
    enablePassword: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const DEBOUNCE_MS = 600;
    const PRE_WRITE_DELAY_MS = 400;
    const OVERALL_TIMEOUT_MS = 30_000;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    return new Promise((resolve, reject) => {
      const child = spawnChild("sshpass", [
        "-e", "ssh", "-tt",
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "KexAlgorithms=+diffie-hellman-group1-sha1",
        "-o", "HostKeyAlgorithms=+ssh-rsa",
        "-o", "Ciphers=+aes128-cbc",
        `${username}@${host}`,
      ], { env: { ...process.env, SSHPASS: password } });

      let buffer = "";
      let stage: "login" | "enable-sent" | "password-sent" | "unpaginating" | "command-sent" = "login";
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const finish = (result: { stdout: string; stderr: string; exitCode: number } | null, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimeout);
        child.kill();
        if (error) reject(error);
        else resolve(result!);
      };

      const overallTimeout = setTimeout(
        () => finish(null, new Error(`Interactive SSH session to ${host} timed out (last buffer: ${JSON.stringify(buffer.slice(-200))})`)),
        OVERALL_TIMEOUT_MS
      );

      const onSettled = () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          try {
            if (stage === "login" && /[>#]\s*$/.test(buffer)) {
              stage = "enable-sent";
              buffer = "";
              await sleep(PRE_WRITE_DELAY_MS);
              child.stdin.write("enable\r");
            } else if (stage === "enable-sent" && /password:\s*$/i.test(buffer)) {
              stage = "password-sent";
              buffer = "";
              await sleep(PRE_WRITE_DELAY_MS);
              child.stdin.write(`${enablePassword}\r`);
            } else if (stage === "password-sent") {
              if (/#\s*$/.test(buffer)) {
                stage = "unpaginating";
                buffer = "";
                await sleep(PRE_WRITE_DELAY_MS);
                child.stdin.write("terminal length 0\r");
              } else if (/access denied/i.test(buffer)) {
                finish(null, new Error(`Enable authentication failed on ${host}`));
              }
            } else if (stage === "unpaginating" && /#\s*$/.test(buffer)) {
              stage = "command-sent";
              buffer = "";
              await sleep(PRE_WRITE_DELAY_MS);
              child.stdin.write(`${command}\r`);
            } else if (stage === "command-sent" && /#\s*$/.test(buffer)) {
              // Strip the echoed command line and the trailing prompt line.
              const lines = buffer.replace(/\r/g, "").split("\n");
              const firstRealLine = lines[0]?.trim() === command.trim() ? 1 : 0;
              const withoutPrompt = lines.slice(firstRealLine, -1).join("\n");
              finish({ stdout: withoutPrompt, stderr: "", exitCode: 0 });
            }
          } catch (error: any) {
            finish(null, error);
          }
        }, DEBOUNCE_MS);
      };

      child.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        onSettled();
      });
      child.on("error", (error) => finish(null, error));
      child.on("close", (code) => {
        if (!settled) finish(null, new Error(`Interactive SSH session to ${host} closed unexpectedly (exit ${code})`));
      });
    });
  }

  /**
   * ssh2 (the pure-JS library the connection pool uses) lists
   * diffie-hellman-group1-sha1 in its own default KEX constants but throws
   * "Unknown DH group" if it's actually negotiated — this library appears
   * unable to complete that exchange even though it recognizes the name.
   * The system OpenSSH client handles it fine, so old gear that only offers
   * this KEX (e.g. this repo's Cisco 2960G) is routed through the real
   * `ssh` binary via sshpass instead of the ssh2 connection pool.
   */
  private async executeLegacySSHCommand(
    host: string,
    command: string,
    username: string,
    password: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const { stdout, stderr } = await execFileAsync(
        "sshpass",
        [
          "-e", "ssh",
          "-o", "ConnectTimeout=10",
          "-o", "StrictHostKeyChecking=accept-new",
          "-o", "KexAlgorithms=+diffie-hellman-group1-sha1",
          "-o", "HostKeyAlgorithms=+ssh-rsa",
          "-o", "Ciphers=+aes128-cbc",
          `${username}@${host}`,
          command,
        ],
        { env: { ...process.env, SSHPASS: password }, timeout: 20000, maxBuffer: 10 * 1024 * 1024 }
      );
      return { stdout, stderr, exitCode: 0 };
    } catch (error: any) {
      // execFile rejects on non-zero exit; surface stdout/stderr if present
      // instead of just the generic "Command failed" message.
      return {
        stdout: error?.stdout || "",
        stderr: error?.stderr || error?.message || "sshpass/ssh execution failed",
        exitCode: typeof error?.code === "number" ? error.code : 1,
      };
    }
  }

  private async executeSSHCommand(
    host: string,
    command: string,
    username?: string,
    privateKey?: string,
    password?: string,
    resolvedHost?: string,
    legacyCompat?: boolean,
    enablePassword?: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const targetHost = resolvedHost || host;

    if (legacyCompat) {
      if (!password) {
        throw new Error(`Legacy SSH host ${targetHost} requires a password (key auth is not supported for this path)`);
      }
      if (enablePassword) {
        return this.executeLegacyInteractiveSSHCommand(targetHost, command, username || "root", password, enablePassword);
      }
      return this.executeLegacySSHCommand(targetHost, command, username || "root", password);
    }

    let conn: Client;

    try {
      // Get connection from pool
      conn = await sshPool.getConnection(targetHost, username, privateKey, password);
    } catch (error) {
      throw error;
    }

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let shellStream: any = null;
      let commandExecuted = false;

      // Connection is already ready from pool
      const executeCommand = () => {
        // For Proxmox nodes, use exec for cleaner output
        // For OPNsense, we need shell to navigate the menu
        const useShell = targetHost.includes("172.16.0.1") || 
                        targetHost.includes("opnsense") ||
                        targetHost.includes("radar") ||
                        targetHost.includes("firewall");
        
        if (useShell) {
          // OPNsense uses an interactive shell with a menu
          // We need to start a shell session and select option 8 (shell)
          conn.shell((err, stream) => {
          if (err) {
            sshPool.releaseConnection(targetHost, username);
            reject(err);
            return;
          }

          shellStream = stream;
          let menuBuffer = "";
          let shellReady = false;
          let promptDetected = false;
          let rawOutput = ""; // Collect ALL raw output for debugging
          let completionMarker = "";
          let commandExitCode = 0;
          let commandCompleted = false;
          let closeTimer: NodeJS.Timeout | null = null;

          stream.on("data", (data: Buffer) => {
            const text = data.toString();
            rawOutput += text; // Keep raw output for debugging
            menuBuffer += text;

            // Check if we're at the OPNsense menu (look for menu indicators)
            if (!shellReady && (text.includes("Enter an option") || text.includes("8) Shell"))) {
              // Send "8" to select shell option
              logger.info("OPNsense menu detected, selecting shell (option 8)");
              stream.write("8\n");
              shellReady = true;
              return;
            }

            // Detect shell prompt (for both OPNsense and regular Linux shells)
            // Look for common prompt patterns: username@hostname, $, #, etc.
            if (!promptDetected && (
              text.match(/[a-zA-Z0-9_-]+@[a-zA-Z0-9_.-]+[:\s]+[~#\$]/) ||
              text.match(/[~#\$]\s*$/) ||
              text.match(/root@.*[#>$]\s*$/m) ||
              text.includes("~ #") ||
              text.includes("~ $") ||
              text.match(/\[.*@.*\].*[#\$]\s*$/)
            )) {
              promptDetected = true;
              shellReady = true;
            }

            // Once in shell, wait for prompt then execute command
            if (shellReady && !commandExecuted) {
              // For regular Linux shells, execute immediately after detecting prompt
              // For OPNsense, we already handled it above
              if (promptDetected || text.match(/[~#\$]\s*$/m)) {
                commandExecuted = true;
                logger.info(`Executing command in shell: ${command}`);
                completionMarker =
                  `__PALINDROME_COMMAND_DONE_${Date.now()}_${Math.random()
                    .toString(16)
                    .slice(2)}__`;
                // The marker provides deterministic command completion and the
                // real remote exit code. OPNsense's interactive menu otherwise
                // offers no reliable channel-close event for individual commands.
                // Its root shell is tcsh, where the last exit code is $status.
                stream.write(
                  `${command}; echo ${completionMarker}:$status\n`
                );
                return;
              }
            }

            // Collect command output - collect everything, filter later
            if (commandExecuted) {
              stdout += text; // Collect raw output first
              if (!commandCompleted && completionMarker) {
                const completionPattern = new RegExp(
                  `${completionMarker}:(\\d+)`
                );
                const completion = stdout.match(completionPattern);
                if (completion) {
                  commandCompleted = true;
                  commandExitCode = Number.parseInt(completion[1] ?? "1", 10);
                  stdout = stdout.replace(completionPattern, "");
                  stream.write("exit\n");
                  closeTimer = setTimeout(() => stream.close(), 100);
                }
              }
            }
          });

          stream.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
          });

          // Add timeout to prevent hanging
          const timeout = setTimeout(() => {
            commandExitCode = 124;
            stderr +=
              `${stderr.endsWith("\n") || stderr.length === 0 ? "" : "\n"}` +
              "SSH command timed out before receiving its completion marker";
            logger.error("SSH command timeout before completion marker", {
              command,
              host: targetHost,
              outputLength: stdout.length,
            });
            stream.close();
          }, 15000);

          stream.on("close", () => {
            clearTimeout(timeout);
            if (closeTimer) clearTimeout(closeTimer);
            if (commandExecuted && !commandCompleted && commandExitCode === 0) {
              commandExitCode = 1;
              stderr +=
                `${stderr.endsWith("\n") || stderr.length === 0 ? "" : "\n"}` +
                "SSH channel closed before receiving its completion marker";
            }
            // Don't close connection, release it back to pool
            sshPool.releaseConnection(targetHost, username);
            
            // Process collected output
            // Remove ANSI escape codes and control sequences more aggressively
            let cleanOutput = stdout
              .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // ANSI escape codes
              .replace(/\x1b\[[?0-9;]*[hl]/g, '') // More ANSI codes
              .replace(/\[?2004[hl]/g, '') // Bracketed paste mode
              .replace(/\x1b\[[0-9;]*m/g, '') // Color codes
              .replace(/\x1b\[K/g, '') // Clear line
              .replace(/\x1b\[[0-9]*[JK]/g, '') // More clear codes
              .replace(/\r/g, '') // Carriage returns
              .replace(/\x1b/g, ''); // Any remaining escape chars
            
            // Split into lines and filter
            const lines = cleanOutput.split("\n");
            const filteredLines: string[] = [];
            
            for (const line of lines) {
              const cleanLine = line.trim();
              
              // Skip empty lines
              if (cleanLine.length === 0) continue;
              
              // Skip menu text and OPNsense-specific content
              if (cleanLine.includes("Enter an option") || 
                  cleanLine.includes("OPNsense") ||
                  cleanLine.match(/^\d+\)\s+/)) {
                continue;
              }
              
              // Skip shell prompts (but be less aggressive)
              if (cleanLine.match(/^[a-zA-Z0-9_-]+@[a-zA-Z0-9_.-]+[:\s]+[~#\$].*[#>$]\s*$/)) {
                continue;
              }
              
              // Skip command echo (exact match)
              if (cleanLine === command.trim() || 
                  cleanLine === `$ ${command.trim()}` ||
                  cleanLine === `# ${command.trim()}`) {
                continue;
              }

              // Skip the decorated command echo and completion marker used to
              // detect the end of an interactive OPNsense command.
              if (cleanLine.includes("__PALINDROME_COMMAND_DONE_")) {
                continue;
              }
              
              // Skip exit/logout commands
              if (cleanLine === "exit" || cleanLine === "logout") {
                continue;
              }
              
              // Skip OPNsense-specific content
              if (cleanLine.match(/^HomeNetwork|^LabNetwork|^securityLab|^HTTPS:|^SSH:/)) {
                continue;
              }
              
              // Skip fingerprints and hashes
              if (cleanLine.match(/^SHA256/) ||
                  cleanLine.match(/^[A-F0-9]{2}(\s+[A-F0-9]{2}){15}$/) ||
                  cleanLine.match(/^[a-f0-9]{64}$/)) {
                continue;
              }
              
              // Keep guest agent errors for debugging, but we'll filter them if they're the only output
              // For now, include everything else
              filteredLines.push(cleanLine);
            }
            
            let commandOutput = filteredLines.join("\n").trim();
            
            // If output is just guest agent errors, log them but return empty
            if (commandOutput.match(/^ipcc_send_rec.*\nUnable to load access control list.*$/s) && 
                !commandOutput.match(/[\{\[]/)) {
              logger.warn("Guest agent errors detected, but no JSON output", { 
                rawOutput: rawOutput.substring(0, 500),
                command 
              });
              // Still return the errors so caller knows what happened
            }
            
            // Log raw output for debugging if it's suspiciously short
            if (commandOutput.length < 10 && rawOutput.length > 100) {
              logger.debug("Output seems filtered too aggressively", {
                commandOutputLength: commandOutput.length,
                rawOutputLength: rawOutput.length,
                rawOutputSample: rawOutput.substring(0, 500)
              });
            }
            
            resolve({ 
              stdout: commandOutput || stdout, 
              stderr, 
              exitCode: commandExitCode
            });
          });
        });
        } else {
          // For regular Linux hosts (like Proxmox), use exec for direct command execution
          logger.info(`Using exec mode for host: ${targetHost}`);
          conn.exec(command, (err, stream) => {
            if (err) {
              conn.end();
              reject(err);
              return;
            }

            stream.on("data", (data: Buffer) => {
              stdout += data.toString();
            });

            stream.stderr.on("data", (data: Buffer) => {
              stderr += data.toString();
            });

            stream.on("close", (code: number) => {
              // Don't close connection, release it back to pool
              sshPool.releaseConnection(targetHost, username);
              
              // Clean output - remove ANSI codes
              let cleanStdout = stdout
                .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
                .replace(/\x1b\[[?0-9;]*[hl]/g, '')
                .replace(/\[?2004[hl]/g, '')
                .replace(/\x1b\[[0-9;]*m/g, '')
                .replace(/\x1b\[K/g, '')
                .replace(/\x1b\[[0-9]*[JK]/g, '')
                .replace(/\r/g, '')
                .replace(/\x1b/g, '')
                .trim();
              
              let cleanStderr = stderr
                .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
                .replace(/\x1b\[[?0-9;]*[hl]/g, '')
                .replace(/\[?2004[hl]/g, '')
                .replace(/\r/g, '')
                .trim();
              
              // If stderr has guest agent errors but stdout has actual data, prefer stdout
              // Guest agent errors are often harmless warnings
              const hasGuestAgentErrors = cleanStderr.includes("ipcc_send_rec") || 
                                         cleanStderr.includes("Unable to load access control list");
              
              if (hasGuestAgentErrors && cleanStdout.length > 0) {
                logger.debug("Guest agent errors detected but stdout has data", {
                  stdoutLength: cleanStdout.length,
                  stderrLength: cleanStderr.length
                });
              }
              
              resolve({
                stdout: cleanStdout,
                stderr: cleanStderr,
                exitCode: code || 0,
              });
            });
          });
        }
      };

      conn.on("error", (err) => {
        // Remove connection from pool on error
        sshPool.releaseConnection(targetHost, username);
        reject(err);
      });

      // Execute command immediately since connection is ready
      // Small delay to ensure connection is fully ready
      setImmediate(() => {
        executeCommand();
      });
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

    // Validate command is approved (may expand aliases)
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
    
    // Use expanded command if alias was expanded
    const commandToExecute = approval.expandedCommand || command;
    
    // Resolve host alias to actual hostname
    const resolvedHost = this.resolveHost(host);
    if (!resolvedHost) {
      return {
        error: `Could not resolve host "${host}"`,
        durationMs: Date.now() - started,
      };
    }

    try {
      // Support placeholder substitution in commands (e.g., {vmid} -> actual vmid)
      // This allows commands like "qm guest cmd {vmid} network-get-interfaces"
      let finalCommand = commandToExecute;
      
      // Handle {vmid} placeholder
      if (params.vmid && commandToExecute.includes("{vmid}")) {
        finalCommand = finalCommand.replace(/{vmid}/g, String(params.vmid));
      }
      
      // Handle {node} placeholder
      // For pvesh commands executed via SSH, {node} should be replaced with $(hostname)
      // to get the actual Proxmox node name at runtime (not the SSH hostname)
      // Example: "pvesh get /nodes/{node}/qemu" -> "pvesh get /nodes/$(hostname)/qemu"
      if (commandToExecute.includes("{node}")) {
        if (commandToExecute.includes("pvesh")) {
          // For pvesh commands, use $(hostname) to get the actual Proxmox node name
          // This works because pvesh on a local node can use the hostname
          finalCommand = finalCommand.replace(/{node}/g, "$(hostname)");
        } else if (params.node) {
          // For other commands, use the provided node parameter if available
          finalCommand = finalCommand.replace(/{node}/g, params.node);
        }
      }
      
      // Also support {hostname} placeholder
      if (commandToExecute.includes("{hostname}")) {
        // We'll need to get hostname, but for now use resolvedHost
        finalCommand = finalCommand.replace(/{hostname}/g, resolvedHost);
      }
      
      const logCommand = approval.expandedCommand ? `${command} (expanded to: ${approval.expandedCommand})` : finalCommand;
      logger.info(`Executing approved SSH command on ${resolvedHost} (requested as ${host}): ${logCommand}`);

      // Get SSH credentials from config first, then environment (use resolved host for env vars)
      const config = this.loadApprovedCommands();
      const hostConfig = config.hosts[resolvedHost];
      const envHostKey = resolvedHost.replace(/\./g, "_");
      let username = hostConfig?.username || process.env[`SSH_USER_${envHostKey}`] || process.env.SSH_USER || "root";
      let password = process.env[`SSH_PASSWORD_${envHostKey}`] || process.env.SSH_PASSWORD;
      let privateKey = process.env[`SSH_KEY_${envHostKey}`];
      // Only meaningful for legacy_ssh hosts — enables privileged-EXEC
      // commands via an interactive `enable` handshake. See
      // executeLegacyInteractiveSSHCommand.
      const enablePassword = process.env[`SSH_ENABLE_PASSWORD_${envHostKey}`];
      
      // If no key specified, try to use default SSH keys for passwordless auth
      if (!privateKey && !password) {
        const fs = await import("fs/promises");
        const os = await import("os");
        const path = await import("path");
        const homeDir = os.homedir();
        const defaultKeys = [
          path.join(homeDir, ".ssh", "id_rsa"),
          path.join(homeDir, ".ssh", "id_ed25519"),
          path.join(homeDir, ".ssh", "id_ecdsa"),
        ];
        
        for (const keyPath of defaultKeys) {
          try {
            await fs.access(keyPath);
            privateKey = await fs.readFile(keyPath, "utf-8");
            logger.info(`Using default SSH key: ${keyPath}`);
            break;
          } catch {
            // Key doesn't exist, try next one
          }
        }
      }

      // Remove quotes if present (dotenv might preserve them)
      if (username) username = username.replace(/^["']|["']$/g, "");
      if (password) password = password.replace(/^["']|["']$/g, "");

      logger.info(`SSH auth: user=${username}, hasPassword=${!!password}, hasKey=${!!privateKey}`);

      const result = await this.executeSSHCommand(
        resolvedHost, finalCommand, username, privateKey, password, resolvedHost, hostConfig?.legacy_ssh === true, enablePassword
      );

      if (result.exitCode !== 0) {
        return {
          error: `Command failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
          durationMs: Date.now() - started,
        };
      }

      // Convert temperature output to Fahrenheit if this is a sensors command
      let processedStdout = result.stdout;
      if (finalCommand.trim().startsWith("sensors")) {
        processedStdout = this.convertTemperatureToFahrenheit(result.stdout, finalCommand.includes("-j"));
      }

      return {
        data: {
          host: resolvedHost,
          requestedHost: host,
          command,
          stdout: processedStdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
        durationMs: Date.now() - started,
      };
    } catch (err: any) {
      let errorMessage = typeof err?.message === "string" ? err.message.trim() : "";
      if (!errorMessage || errorMessage.length < 5) {
        errorMessage = "SSH command execution failed";
      }
      logger.error(`SSH error: ${errorMessage}`);
      return {
        error: errorMessage,
        durationMs: Date.now() - started,
      };
    }
  }
}
