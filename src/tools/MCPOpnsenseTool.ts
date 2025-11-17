/**
 * MCP OPNsense Tool - Hybrid approach
 * 
 * Uses module/action pattern to group 88+ MCP tools into logical modules.
 * Auto-discovers available tools from MCP server and groups them by module.
 */

import { BaseTool } from "./BaseTool";
import { MCPOpnsenseParams, type OPNsenseModule } from "./schemas/mcp-opnsense";
import type { ExecutionResult, ExecutionContext } from "../types/execution";
import type { ToolSchema } from "./tool-schema";
import { createToolSchema } from "./tool-helpers";
import { MCPClient, type MCPTool } from "../utils/mcp-client";
import { logger } from "../utils/logger";

interface ModuleGroup {
  module: OPNsenseModule;
  tools: MCPTool[];
  description: string;
}

export class MCPOpnsenseTool extends BaseTool {
  private mcpClient: MCPClient | null = null;
  private moduleGroups: Map<OPNsenseModule, ModuleGroup> = new Map();
  private allTools: MCPTool[] = [];
  private discoveryComplete = false;
  private discoveryPromise: Promise<void> | null = null;

  constructor() {
    super({
      name: "mcp_opnsense",
      description: "Access OPNsense via MCP server. Organized by modules: firewall, system, interfaces, routing, dhcp, dns, vpn, diagnostics, firmware.",
      categories: ["mcp", "opnsense", "networking", "firewall"],
    });
  }

  /**
   * Initialize MCP client and discover tools
   * Uses a promise cache to avoid concurrent discovery
   */
  private async ensureInitialized(): Promise<void> {
    if (this.discoveryComplete) {
      return;
    }

    // If discovery is already in progress, wait for it
    if (this.discoveryPromise) {
      return this.discoveryPromise;
    }

    // Start discovery and cache the promise
    this.discoveryPromise = this._doDiscovery();
    return this.discoveryPromise;
  }

  /**
   * Internal method to perform discovery
   */
  private async _doDiscovery(): Promise<void> {

    try {
      // Create MCP client from environment or config
      const command = process.env.MCP_OPNSENSE_COMMAND || "npx";
      const args = process.env.MCP_OPNSENSE_ARGS 
        ? JSON.parse(process.env.MCP_OPNSENSE_ARGS)
        : ["-y", "@richard-stovall/opnsense-mcp-server"];

      const env: Record<string, string> = {};
      if (process.env.OPNSENSE_URL) env.OPNSENSE_URL = process.env.OPNSENSE_URL;
      if (process.env.OPNSENSE_API_KEY) env.OPNSENSE_API_KEY = process.env.OPNSENSE_API_KEY;
      if (process.env.OPNSENSE_API_SECRET) env.OPNSENSE_API_SECRET = process.env.OPNSENSE_API_SECRET;
      if (process.env.OPNSENSE_VERIFY_SSL) env.OPNSENSE_VERIFY_SSL = process.env.OPNSENSE_VERIFY_SSL;

      this.mcpClient = new MCPClient(command, args, env);
      await this.mcpClient.initialize();

      // Discover all tools
      this.allTools = await this.mcpClient.listTools();
      logger.info(`Discovered ${this.allTools.length} MCP tools`);

      // Group tools by module
      this.groupToolsByModule();

      this.discoveryComplete = true;
    } catch (error: any) {
      logger.error(`Failed to initialize MCP client: ${error.message}`);
      this.discoveryPromise = null; // Reset on error so we can retry
      throw error;
    } finally {
      // Clear promise cache once complete (success or failure)
      if (this.discoveryComplete || this.discoveryPromise) {
        // Keep promise cached on success, clear on failure
      }
    }
  }

  /**
   * Group MCP tools by OPNsense module
   * MCP tool names typically follow pattern: opnsense_<module>_<action>
   */
  private groupToolsByModule(): void {
    const moduleDescriptions: Record<OPNsenseModule, string> = {
      core: "Core system operations and status",
      firewall: "Firewall rules, aliases, categories, NAT",
      interfaces: "Network interfaces, VLANs, virtual IPs",
      routing: "Static routes, gateways, routing tables",
      dhcp: "DHCP server configuration and leases",
      dns: "DNS/unbound configuration and queries",
      vpn: "VPN configurations (IPsec, OpenVPN, WireGuard)",
      system: "System settings, users, backups, logs",
      diagnostics: "Diagnostic tools, monitoring, logs",
      firmware: "Firmware updates, plugins, packages",
    };

    // Initialize module groups
    for (const module of Object.keys(moduleDescriptions) as OPNsenseModule[]) {
      this.moduleGroups.set(module, {
        module,
        tools: [],
        description: moduleDescriptions[module],
      });
    }

    // Group tools by module prefix
    for (const tool of this.allTools) {
      // MCP tool names: "opnsense_firewall_list_rules" or "firewall_list_rules"
      const parts = tool.name.toLowerCase().split("_");
      
      // Find matching module
      for (const [module, group] of this.moduleGroups.entries()) {
        if (parts.includes(module) || tool.name.toLowerCase().startsWith(module + "_")) {
          group.tools.push(tool);
          break;
        }
      }
    }

    // Log grouping results
    for (const [module, group] of this.moduleGroups.entries()) {
      if (group.tools.length > 0) {
        logger.info(`Module ${module}: ${group.tools.length} tools`);
      }
    }
  }

  /**
   * Get available actions for a module
   */
  private getModuleActions(module: OPNsenseModule): string[] {
    const group = this.moduleGroups.get(module);
    if (!group) {
      return [];
    }

    // Extract action names from tool names
    // MCP tool names can be: "opnsense_core_manage", "firewall_alias_list", etc.
    return group.tools.map(tool => {
      const toolName = tool.name.toLowerCase();
      const parts = toolName.split("_");
      
      // Remove "opnsense" prefix if present
      const startIndex = parts[0] === "opnsense" ? 1 : 0;
      const remaining = parts.slice(startIndex);
      
      // Find module index
      const moduleIndex = remaining.indexOf(module);
      if (moduleIndex >= 0 && moduleIndex < remaining.length - 1) {
        // Return everything after the module name
        return remaining.slice(moduleIndex + 1).join("_");
      }
      
      // Fallback: if module is first part, return rest
      if (remaining[0] === module && remaining.length > 1) {
        return remaining.slice(1).join("_");
      }
      
      // Last resort: return full tool name
      return tool.name;
    });
  }

  /**
   * Find MCP tool by module and action
   */
  private findMCPTool(module: OPNsenseModule, action: string): MCPTool | null {
    const group = this.moduleGroups.get(module);
    if (!group) {
      return null;
    }

    const actionLower = action.toLowerCase();
    const moduleLower = module.toLowerCase();

    // Try various naming patterns
    const patterns = [
      `opnsense_${moduleLower}_${actionLower}`,
      `${moduleLower}_${actionLower}`,
      `${actionLower}`, // Just the action (for tools like "manage")
    ];

    for (const pattern of patterns) {
      const exactMatch = group.tools.find(tool => 
        tool.name.toLowerCase() === pattern
      );
      if (exactMatch) {
        return exactMatch;
      }
    }

    // Try partial match - tool name contains both module and action
    const partialMatch = group.tools.find(tool => {
      const toolName = tool.name.toLowerCase();
      return toolName.includes(moduleLower) && toolName.includes(actionLower);
    });

    if (partialMatch) {
      return partialMatch;
    }

    // Try action-only match (some tools might just be the action name)
    const actionOnlyMatch = group.tools.find(tool => 
      tool.name.toLowerCase() === actionLower ||
      tool.name.toLowerCase().endsWith(`_${actionLower}`)
    );

    return actionOnlyMatch || null;
  }

  getSchema(): ToolSchema {
    // Ensure we have discovered tools (synchronous, but schema might be called before init)
    // For now, return a schema that will work, and we'll validate at execution time
    const moduleDescriptions: Record<string, string> = {
      core: "Core system operations",
      firewall: "Firewall rules, aliases, NAT",
      interfaces: "Network interfaces, VLANs",
      routing: "Static routes, gateways",
      dhcp: "DHCP server",
      dns: "DNS/unbound",
      vpn: "VPN configurations",
      system: "System settings, users",
      diagnostics: "Diagnostics, monitoring",
      firmware: "Firmware, plugins",
    };

    const examples = [
      {
        description: "List firewall rules",
        parameters: { module: "firewall", action: "list_rules" }
      },
      {
        description: "Get system status",
        parameters: { module: "core", action: "system_status" }
      },
      {
        description: "List network interfaces",
        parameters: { module: "interfaces", action: "list" }
      }
    ];

    const notes = [
      "This tool uses the OPNsense MCP server with 88+ available tools",
      "Tools are organized by module for easier discovery",
      "Available modules: core, firewall, interfaces, routing, dhcp, dns, vpn, system, diagnostics, firmware",
      "Actions are auto-discovered from the MCP server",
      "Use 'list' or 'search' actions to discover available operations for each module",
    ];

    return createToolSchema(this, MCPOpnsenseParams, {
      examples,
      notes,
    });
  }

  getParameterSchema() {
    return MCPOpnsenseParams;
  }

  async execute(
    params: Record<string, any>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const started = context.startedAt ?? Date.now();

    try {
      // Ensure MCP client is initialized
      await this.ensureInitialized();

      // Validate parameters
      const parsed = MCPOpnsenseParams.safeParse(params);
      if (!parsed.success) {
        return { error: parsed.error.message, durationMs: Date.now() - started };
      }

      const { module, action, parameters = {} } = parsed.data;

      // Find the MCP tool
      // Special handling: if action is a known method name (like "systemStatus"), 
      // and module is "core", use "manage" as the tool name and pass method as parameter
      let mcpToolName: string;
      let mcpParams = { ...parameters };

      if (module === "core" && !this.findMCPTool(module, action)) {
        // For core module, try "manage" tool with method parameter
        const manageTool = this.findMCPTool(module, "manage");
        if (manageTool) {
          mcpToolName = manageTool.name;
          mcpParams = { ...parameters, method: action };
        } else {
          const availableActions = this.getModuleActions(module);
          return {
            error: `Action "${action}" not found in module "${module}". Available actions: ${availableActions.slice(0, 10).join(", ")}${availableActions.length > 10 ? "..." : ""}`,
            durationMs: Date.now() - started,
          };
        }
      } else {
        const mcpTool = this.findMCPTool(module, action);
        if (!mcpTool) {
          const availableActions = this.getModuleActions(module);
          return {
            error: `Action "${action}" not found in module "${module}". Available actions: ${availableActions.slice(0, 10).join(", ")}${availableActions.length > 10 ? "..." : ""}`,
            durationMs: Date.now() - started,
          };
        }
        mcpToolName = mcpTool.name;
      }

      // Call MCP tool
      logger.info(`Calling MCP tool: ${mcpToolName} with params: ${JSON.stringify(mcpParams)}`);
      const result = await this.mcpClient!.callTool(mcpToolName, mcpParams);

      if (result.isError) {
        return {
          error: result.content?.[0]?.text || "MCP tool execution failed",
          durationMs: Date.now() - started,
        };
      }

      // Extract data from MCP result
      const data = result.content?.[0]?.data || result.content?.[0]?.text || result;

      return {
        data,
        durationMs: Date.now() - started,
      };
    } catch (error: any) {
      logger.error(`MCP OPNsense tool error: ${error.message}`);
      return {
        error: error.message || "MCP tool execution failed",
        durationMs: Date.now() - started,
      };
    }
  }

  /**
   * Get module information (for debugging/help)
   */
  async getModuleInfo(module: OPNsenseModule): Promise<ModuleGroup | null> {
    await this.ensureInitialized();
    return this.moduleGroups.get(module) || null;
  }

  /**
   * List all available modules and their tool counts
   */
  async listModules(): Promise<Record<string, number>> {
    await this.ensureInitialized();
    const info: Record<string, number> = {};
    for (const [module, group] of this.moduleGroups.entries()) {
      if (group.tools.length > 0) {
        info[module] = group.tools.length;
      }
    }
    return info;
  }
}

