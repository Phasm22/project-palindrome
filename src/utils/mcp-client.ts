/**
 * MCP (Model Context Protocol) Client
 * 
 * Communicates with MCP servers via stdio using JSON-RPC 2.0
 * Supports tool discovery and execution
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

export interface MCPCallToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: any;
  }>;
  isError?: boolean;
}

export class MCPClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }>();
  private initialized = false;

  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>
  ) {
    super();
  }

  /**
   * Initialize the MCP connection
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.process = spawn(this.command, this.args, {
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let initBuffer = "";

      this.process.stdout?.on("data", (data: Buffer) => {
        const text = data.toString();
        initBuffer += text;

        // Try to parse JSON messages
        const lines = initBuffer.split("\n");
        initBuffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            try {
              const message = JSON.parse(line);
              this.handleMessage(message);
            } catch (e) {
              // Not JSON, might be log output
            }
          }
        }
      });

      this.process.stderr?.on("data", (data: Buffer) => {
        // Log stderr but don't treat as errors
        const text = data.toString();
        if (text.trim()) {
          this.emit("log", { level: "error", message: text });
        }
      });

      this.process.on("error", (error) => {
        reject(error);
      });

      // Send initialize request
      this.sendRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        clientInfo: {
          name: "project-palindrome",
          version: "1.0.0",
        },
      })
        .then(() => {
          // Send initialized notification
          this.sendNotification("notifications/initialized", {});
          this.initialized = true;
          resolve();
        })
        .catch(reject);
    });
  }

  /**
   * List available tools from the MCP server
   */
  async listTools(): Promise<MCPTool[]> {
    await this.ensureInitialized();
    const response = await this.sendRequest("tools/list", {});
    return response.tools || [];
  }

  /**
   * Call a tool on the MCP server
   */
  async callTool(name: string, arguments_: Record<string, any>): Promise<MCPCallToolResult> {
    await this.ensureInitialized();
    const response = await this.sendRequest("tools/call", {
      name,
      arguments: arguments_,
    });
    return response;
  }

  /**
   * Send a JSON-RPC request
   */
  private sendRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const request = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      this.pendingRequests.set(id, { resolve, reject });

      if (!this.process?.stdin) {
        reject(new Error("MCP process not initialized"));
        return;
      }

      this.process.stdin.write(JSON.stringify(request) + "\n");

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  private sendNotification(method: string, params: any): void {
    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };

    if (this.process?.stdin) {
      this.process.stdin.write(JSON.stringify(notification) + "\n");
    }
  }

  /**
   * Handle incoming JSON-RPC messages
   */
  private handleMessage(message: any): void {
    if (message.id !== undefined) {
      // Response to a request
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || "MCP error"));
        } else {
          pending.resolve(message.result);
        }
      }
    } else if (message.method) {
      // Notification from server
      this.emit("notification", message);
    }
  }

  /**
   * Ensure the client is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Close the MCP connection
   */
  close(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.initialized = false;
    this.pendingRequests.clear();
  }
}

