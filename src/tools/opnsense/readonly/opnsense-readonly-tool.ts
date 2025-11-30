import { OpnsenseReadOnlyBase } from "./base";
import { z } from "zod";
import type { ToolSchema } from "../../tool-schema";
import { createToolSchema } from "../../tool-helpers";
import type { ExecutionResult, ExecutionContext } from "../../../types/execution";
import { SSHTool } from "../../SSHTool";

/**
 * Schema for OPNsense read-only tool parameters
 * Supports 20+ distinct read-only actions across Firewall, Interfaces, System, Diagnostics, DHCP
 */
export const OpnsenseReadOnlyParams = z.object({
  action: z.enum([
    // Firewall (5 actions)
    "firewall_rules_list",
    "firewall_aliases_list",
    "firewall_aliases_get",
    "firewall_categories_list",
    "firewall_states_list",
    
    // Interfaces (4 actions)
    "interfaces_list",
    "interface_status",
    "interfaces_vlans_list",
    "interfaces_vips_list",
    
    // System (4 actions)
    "system_status",
    "system_health",
    "system_info",
    "system_backups_list",
    
    // Diagnostics (4 actions)
    "diagnostics_arp_table",
    "diagnostics_routing_table",
    "diagnostics_interface_statistics",
    "diagnostics_system_logs",
    
    // DHCP (3 actions)
    "dhcp_leases_list",
    "dhcp_status",
    "dhcp_static_mappings_list",
  ]).describe("The read-only OPNsense operation to perform"),
  
  // Optional parameters for specific actions
  alias_name: z.string().optional().describe("Alias name for firewall_aliases_get"),
  interface_name: z.string().optional().describe("Interface name for interface_status"),
  limit: z.number().optional().describe("Limit number of results (for list operations)"),
});

export type OpnsenseReadOnlyParams = z.infer<typeof OpnsenseReadOnlyParams>;

/**
 * Unified OPNsense Read-Only Tool
 * Provides comprehensive read-only access to OPNsense state
 */
export class OpnsenseReadOnlyTool extends OpnsenseReadOnlyBase {
  private sshTool: SSHTool | null = null;
  constructor() {
    super({
      name: "opnsense_readonly",
      description: "OPNsense read-only tool. Supports firewall_rules_list (uses SSH internally with pfctl commands), firewall aliases (REST API), and other read-only operations. Note: OPNsense REST API is intentionally incomplete (~20-30% coverage). For firewall rules, use opnsense_readonly firewall_rules_list (not direct ssh_execute).",
      categories: ["opnsense", "networking", "firewall", "system"],
      allowedAcls: ["admin", "ops", "viewer"],
      risk: "low",
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, OpnsenseReadOnlyParams, {
      examples: [
        {
          description: "List firewall rules (uses SSH internally with pfctl commands)",
          parameters: { action: "firewall_rules_list" },
        },
        {
          description: "List firewall aliases (REST API works well for aliases)",
          parameters: { action: "firewall_aliases_list" },
        },
        {
          description: "Get a specific firewall alias",
          parameters: { action: "firewall_aliases_get", alias_name: "allowed_guest" },
        },
        {
          description: "List firewall categories",
          parameters: { action: "firewall_categories_list" },
        },
      ],
      notes: [
        "firewall_rules_list action uses SSH internally with approved pfctl commands (parallelized for performance).",
        "Firewall aliases use REST API (good coverage).",
        "For firewall rules, use opnsense_readonly firewall_rules_list (not direct ssh_execute).",
        "All operations are strictly read-only. Write operations will return OPERATION_FORBIDDEN error.",
        "All responses are structured JSON objects for easy parsing and dashboarding.",
        "Internal IP addresses and credentials are automatically sanitized from responses.",
      ],
    });
  }

  override getParameterSchema() {
    return OpnsenseReadOnlyParams;
  }

  async execute(
    params: Record<string, any>,
    context: ExecutionContext
  ): Promise<ExecutionResult> {
    const parsed = OpnsenseReadOnlyParams.safeParse(params);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}` };
    }

    // Validate read-only
    const readOnlyCheck = this.validateReadOnly(parsed.data.action);
    if (readOnlyCheck) {
      return readOnlyCheck;
    }

    const client = this.getApiClient();
    const { action, ...actionParams } = parsed.data;

    // Route to appropriate handler based on action
    return this.executeApiCall(
      () => this.handleAction(action, actionParams, client),
      context
    );
  }

  /**
   * Route action to appropriate handler
   */
  private async handleAction(
    action: string,
    params: Record<string, any>,
    client: any
  ): Promise<any> {
    // Firewall actions
    if (action.startsWith("firewall_")) {
      return this.handleFirewallAction(action, params, client);
    }

    // Interface actions
    if (action.startsWith("interface") || action.startsWith("interfaces_")) {
      return this.handleInterfaceAction(action, params, client);
    }

    // System actions
    if (action.startsWith("system_")) {
      return this.handleSystemAction(action, params, client);
    }

    // Diagnostics actions
    if (action.startsWith("diagnostics_")) {
      return this.handleDiagnosticsAction(action, params, client);
    }

    // DHCP actions
    if (action.startsWith("dhcp_")) {
      return this.handleDhcpAction(action, params, client);
    }

    throw new Error(`Unknown action: ${action}`);
  }

  /**
   * Handle firewall-related actions
   */
  private async handleFirewallAction(
    action: string,
    params: Record<string, any>,
    client: any
  ): Promise<any> {
    switch (action) {
      case "firewall_rules_list":
        return this.getFirewallRules(client, params.limit);

      case "firewall_aliases_list":
        return this.getFirewallAliases(client, params.limit);

      case "firewall_aliases_get":
        if (!params.alias_name) {
          throw new Error("alias_name parameter required for firewall_aliases_get");
        }
        return this.getFirewallAlias(client, params.alias_name);

      case "firewall_categories_list":
        return this.getFirewallCategories(client);

      case "firewall_states_list":
        return this.getFirewallStates(client, params.limit);

      default:
        throw new Error(`Unknown firewall action: ${action}`);
    }
  }

  /**
   * Handle interface-related actions
   */
  private async handleInterfaceAction(
    action: string,
    params: Record<string, any>,
    client: any
  ): Promise<any> {
    switch (action) {
      case "interfaces_list":
        return this.getInterfaces(client);

      case "interface_status":
        return this.getInterfaceStatus(client, params.interface_name);

      case "interfaces_vlans_list":
        return this.getVlans(client);

      case "interfaces_vips_list":
        return this.getVips(client);

      default:
        throw new Error(`Unknown interface action: ${action}`);
    }
  }

  /**
   * Handle system-related actions
   */
  private async handleSystemAction(
    action: string,
    params: Record<string, any>,
    client: any
  ): Promise<any> {
    switch (action) {
      case "system_status":
        return this.getSystemStatus(client);

      case "system_health":
        return this.getSystemHealth(client);

      case "system_info":
        return this.getSystemInfo(client);

      case "system_backups_list":
        return this.getSystemBackups(client);

      default:
        throw new Error(`Unknown system action: ${action}`);
    }
  }

  /**
   * Handle diagnostics-related actions
   */
  private async handleDiagnosticsAction(
    action: string,
    params: Record<string, any>,
    client: any
  ): Promise<any> {
    switch (action) {
      case "diagnostics_arp_table":
        return this.getArpTable(client);

      case "diagnostics_routing_table":
        return this.getRoutingTable(client);

      case "diagnostics_interface_statistics":
        return this.getInterfaceStatistics(client, params.interface_name);

      case "diagnostics_system_logs":
        return this.getSystemLogs(client, params.limit);

      default:
        throw new Error(`Unknown diagnostics action: ${action}`);
    }
  }

  /**
   * Handle DHCP-related actions
   */
  private async handleDhcpAction(
    action: string,
    params: Record<string, any>,
    client: any
  ): Promise<any> {
    switch (action) {
      case "dhcp_leases_list":
        return this.getDhcpLeases(client);

      case "dhcp_status":
        return this.getDhcpStatus(client);

      case "dhcp_static_mappings_list":
        return this.getDhcpStaticMappings(client);

      default:
        throw new Error(`Unknown DHCP action: ${action}`);
    }
  }

  // ========== Firewall API Methods ==========

  private async getFirewallRules(client: any, limit?: number): Promise<any> {
    // IMPORTANT: OPNsense does NOT expose a firewall rules search/list endpoint in the API.
    // This is a known limitation across OPNsense 23.x, 24.x, and 25.x.
    // 
    // What EXISTS in OPNsense API:
    // - GET /api/firewall/rule/getRule/{uuid} - Get individual rule by UUID
    // - POST /api/firewall/rule/setRule/{uuid} - Update rule
    // - POST /api/firewall/rule/addRule - Create rule
    // - POST /api/firewall/rule/delRule/{uuid} - Delete rule
    //
    // What DOES NOT EXIST:
    // - /api/firewall/rule/search
    // - /api/firewall/rule/searchRule
    // - /api/firewall/rule/list
    // - /api/firewall/filter/search
    // - Any "list all rules" or "search rules" endpoint
    //
    // Workarounds:
    // 1. Use MCP Server (recommended) - exposes firewall rules via MCP tools
    // 2. Parse config file over SSH (current implementation)
    //
    // Therefore, we skip API attempts and go directly to SSH fallback.
    return this.getFirewallRulesViaSSH(limit);
  }

  private async getFirewallAliases(client: any, limit?: number): Promise<any> {
    try {
      const response = await client.post("/api/firewall/alias/searchItem", {});
      const aliases = response.data?.rows || [];
      return {
        action: "firewall_aliases_list",
        count: limit ? Math.min(aliases.length, limit) : aliases.length,
        total: aliases.length,
        aliases: limit ? aliases.slice(0, limit) : aliases,
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      if (error.response?.status === 405 || error.response?.status === 404) {
        const response = await client.get("/api/firewall/alias/searchItem");
        const aliases = response.data?.rows || [];
        return {
          action: "firewall_aliases_list",
          count: limit ? Math.min(aliases.length, limit) : aliases.length,
          total: aliases.length,
          aliases: limit ? aliases.slice(0, limit) : aliases,
          timestamp: new Date().toISOString(),
        };
      }
      throw error;
    }
  }

  private async getFirewallAlias(client: any, aliasName: string): Promise<any> {
    const response = await client.get(`/api/firewall/alias/getItem/${aliasName}`);
    return {
      action: "firewall_aliases_get",
      alias_name: aliasName,
      data: response.data || {},
      timestamp: new Date().toISOString(),
    };
  }

  private async getFirewallCategories(client: any): Promise<any> {
    const response = await client.get("/api/firewall/category/searchItem");
    return {
      action: "firewall_categories_list",
      categories: response.data?.rows || [],
      count: response.data?.rows?.length || 0,
      timestamp: new Date().toISOString(),
    };
  }

  private async getFirewallStates(client: any, limit?: number): Promise<any> {
    const response = await client.get("/api/diagnostics/firewall/states");
    const states = response.data || [];
    return {
      action: "firewall_states_list",
      count: limit ? Math.min(states.length, limit) : states.length,
      total: states.length,
      states: limit ? states.slice(0, limit) : states,
      timestamp: new Date().toISOString(),
    };
  }

  // ========== Interface API Methods ==========

  private async getInterfaces(client: any): Promise<any> {
    const response = await client.get("/api/interfaces/interface/getInterface");
    return {
      action: "interfaces_list",
      interfaces: response.data || {},
      timestamp: new Date().toISOString(),
    };
  }

  private async getInterfaceStatus(client: any, interfaceName?: string): Promise<any> {
    if (interfaceName) {
      const response = await client.get(`/api/interfaces/interface/getInterface/${interfaceName}`);
      return {
        action: "interface_status",
        interface: interfaceName,
        status: response.data || {},
        timestamp: new Date().toISOString(),
      };
    } else {
      // Get all interface statuses
      const response = await client.get("/api/interfaces/interface/getInterface");
      return {
        action: "interface_status",
        interfaces: response.data || {},
        timestamp: new Date().toISOString(),
      };
    }
  }

  private async getVlans(client: any): Promise<any> {
    const response = await client.get("/api/interfaces/vlan/searchVlan");
    return {
      action: "interfaces_vlans_list",
      vlans: response.data?.rows || [],
      count: response.data?.rows?.length || 0,
      timestamp: new Date().toISOString(),
    };
  }

  private async getVips(client: any): Promise<any> {
    const response = await client.get("/api/firewall/vip/searchVip");
    return {
      action: "interfaces_vips_list",
      vips: response.data?.rows || [],
      count: response.data?.rows?.length || 0,
      timestamp: new Date().toISOString(),
    };
  }

  // ========== System API Methods ==========

  private async getSystemStatus(client: any): Promise<any> {
    try {
      const response = await client.get("/api/core/system/status");
      return {
        action: "system_status",
        status: response.data || {},
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      // OPNsense API may not support this endpoint or require different method
      if (error.response?.status === 400 || error.response?.status === 404) {
        throw new Error(
          `OPNsense API endpoint /api/core/system/status is not available or not supported. ` +
          `For system-level information like uptime, memory, and disk usage on OPNsense, use ssh_execute tool instead. ` +
          `Example: ssh_execute with host "opnsense" and command "uptime" or "free -h".`
        );
      }
      throw error;
    }
  }

  private async getSystemHealth(client: any): Promise<any> {
    try {
      const response = await client.get("/api/core/system/health");
      return {
        action: "system_health",
        health: response.data || {},
        timestamp: new Date().toISOString(),
      };
    } catch (error: any) {
      // OPNsense API may not support this endpoint
      if (error.response?.status === 400 || error.response?.status === 404) {
        throw new Error(
          `OPNsense API endpoint /api/core/system/health is not available or not supported. ` +
          `For system health information on OPNsense, use ssh_execute tool instead. ` +
          `Example: ssh_execute with host "opnsense" and command "uptime" or "free -h".`
        );
      }
      throw error;
    }
  }

  private async getSystemInfo(client: any): Promise<any> {
    const response = await client.get("/api/core/system/info");
    return {
      action: "system_info",
      info: response.data || {},
      timestamp: new Date().toISOString(),
    };
  }

  private async getSystemBackups(client: any): Promise<any> {
    const response = await client.get("/api/core/backup/list");
    return {
      action: "system_backups_list",
      backups: response.data || [],
      count: Array.isArray(response.data) ? response.data.length : 0,
      timestamp: new Date().toISOString(),
    };
  }

  // ========== Diagnostics API Methods ==========

  private async getArpTable(client: any): Promise<any> {
    // OPNsense getArp endpoint may require POST with JSON body
    try {
      // Try POST first (many OPNsense diagnostic endpoints require POST)
      const response = await client.post("/api/diagnostics/interface/getArp", {});
      return {
        action: "diagnostics_arp_table",
        arp_entries: response.data || [],
        count: Array.isArray(response.data) ? response.data.length : 0,
        timestamp: new Date().toISOString(),
      };
    } catch (postError: any) {
      // If POST fails, try GET as fallback
      if (postError.response?.status === 405 || postError.response?.status === 400) {
        const response = await client.get("/api/diagnostics/interface/getArp");
        return {
          action: "diagnostics_arp_table",
          arp_entries: response.data || [],
          count: Array.isArray(response.data) ? response.data.length : 0,
          timestamp: new Date().toISOString(),
        };
      }
      throw postError;
    }
  }

  private async getRoutingTable(client: any): Promise<any> {
    const response = await client.get("/api/diagnostics/interface/getRoutes");
    return {
      action: "diagnostics_routing_table",
      routes: response.data || [],
      count: Array.isArray(response.data) ? response.data.length : 0,
      timestamp: new Date().toISOString(),
    };
  }

  private async getInterfaceStatistics(client: any, interfaceName?: string): Promise<any> {
    const endpoint = interfaceName
      ? `/api/diagnostics/interface/getInterfaceStatistics/${interfaceName}`
      : "/api/diagnostics/interface/getInterfaceStatistics";
    const response = await client.get(endpoint);
    return {
      action: "diagnostics_interface_statistics",
      interface: interfaceName || "all",
      statistics: response.data || {},
      timestamp: new Date().toISOString(),
    };
  }

  private async getSystemLogs(client: any, limit?: number): Promise<any> {
    const response = await client.get("/api/diagnostics/system/getLogs");
    const logs = response.data || [];
    return {
      action: "diagnostics_system_logs",
      count: limit ? Math.min(logs.length, limit) : logs.length,
      total: logs.length,
      logs: limit ? logs.slice(0, limit) : logs,
      timestamp: new Date().toISOString(),
    };
  }

  // ========== DHCP API Methods ==========

  private async getDhcpLeases(client: any): Promise<any> {
    // OPNsense searchLease endpoint requires POST with JSON body (even for read operations)
    // Empty body {} should return all leases
    const endpoints = [
      { path: "/api/dhcpv4/leases/searchLease", method: "POST" }, // Correct endpoint per OPNsense docs
      { path: "/api/dhcpv4/lease/list", method: "GET" }, // Fallback
      { path: "/api/dhcp/lease/list", method: "GET" }, // Legacy fallback
    ];

    let lastError: any = null;
    for (const { path, method } of endpoints) {
      try {
        let response;
        if (method === "POST") {
          // POST with empty JSON body to get all leases
          response = await client.post(path, {});
        } else {
          response = await client.get(path);
        }

        // Check if response has data - OPNsense API typically returns {rows: [...]} or {data: [...]}
        const leases = response.data?.rows || response.data?.data || response.data || [];
        return {
          action: "dhcp_leases_list",
          leases: Array.isArray(leases) ? leases : [],
          count: Array.isArray(leases) ? leases.length : 0,
          timestamp: new Date().toISOString(),
          endpoint: path,
          note: "DHCP leases show the last known IP address assigned to each MAC address. If a host is offline, the IP shown is historical (from when it was last online).",
        };
      } catch (error: any) {
        lastError = error;
        // If it's not a 404, it might be a different error (auth, etc.) - don't try other endpoints
        if (error.response?.status !== 404 && error.response?.status !== 405 && error.response?.status !== 400) {
          throw error;
        }
        // Continue to next endpoint if 404, 405, or 400
      }
    }

    // If all endpoints failed, return helpful error
    throw new Error(
      `DHCP leases endpoint not found. Tried: ${endpoints.map(e => `${e.method} ${e.path}`).join(", ")}. ` +
      `This may indicate DHCP is not configured or the OPNsense version uses a different API. ` +
      `Alternative: Use action "diagnostics_arp_table" to find IP addresses by MAC address. ` +
      `Error: ${lastError?.message || "Unknown error"}`
    );
  }

  private async getDhcpStatus(client: any): Promise<any> {
    const response = await client.get("/api/dhcp/status");
    return {
      action: "dhcp_status",
      status: response.data || {},
      timestamp: new Date().toISOString(),
    };
  }

  private async getDhcpStaticMappings(client: any): Promise<any> {
    const response = await client.get("/api/dhcp/static_mapping/searchItem");
    return {
      action: "dhcp_static_mappings_list",
      mappings: response.data?.rows || [],
      count: response.data?.rows?.length || 0,
      timestamp: new Date().toISOString(),
    };
  }

  private getSshTool(): SSHTool {
    if (!this.sshTool) {
      this.sshTool = new SSHTool();
    }
    return this.sshTool;
  }

  private getOpnsenseSshHost(): string {
    return process.env.OPNSENSE_SSH_HOST || "OPNsense.prox";
  }

  // This method is no longer used since we skip API attempts entirely for firewall rules,
  // but kept for potential future use or other endpoints that might need SSH fallback.
  private shouldFallbackToSshForFirewallRules(error: any): boolean {
    if (!error) return false;
    const status = error.response?.status;
    if (status && [400, 404, 405, 501].includes(status)) {
      return true;
    }
    const message = (error.response?.data?.message || error.message || "").toLowerCase();
    return message.includes("invalid json") || message.includes("not available");
  }

  private async getFirewallRulesViaSSH(limit?: number): Promise<any> {
    const host = this.getOpnsenseSshHost();
    const sshTool = this.getSshTool();
    const context = { toolName: this.metadata.name, startedAt: Date.now() };
    const commands = [
      { command: "pfctl -sr", key: "rules" },
      { command: "pfctl -sn", key: "nat" },
      { command: "pfctl -si", key: "info" },
      { command: "pfctl -sa", key: "summary" },
    ];

    // Execute all SSH commands in parallel for better performance
    const results = await Promise.all(
      commands.map(({ command, key }) =>
        sshTool.execute({ host, command }, context).then(
          (result) => ({ key, result }),
          (error) => ({ key, result: { error: error.message || String(error) } })
        )
      )
    );

    const sections: Record<string, any> = {};
    for (const { key, result } of results) {
      if (result.error) {
        sections[key] = { error: result.error };
        continue;
      }
      sections[key] = (result.data?.stdout || "").trim();
    }

    const rulesOutput = typeof sections.rules === "string" ? sections.rules : "";
    const natOutput = typeof sections.nat === "string" ? sections.nat : "";
    const infoOutput = typeof sections.info === "string" ? sections.info : "";
    const summaryValue =
      typeof sections.summary === "string"
        ? sections.summary
        : typeof sections.summary?.error === "string"
        ? sections.summary.error
        : null;

    const rules = this.parsePfctlLines(rulesOutput);
    const natRules = this.parsePfctlLines(natOutput);
    const info = this.parsePfctlInfoOutput(infoOutput);

    return {
      action: "firewall_rules_list",
      source: "ssh_pfctl",
      timestamp: new Date().toISOString(),
      count: limit ? Math.min(rules.length, limit) : rules.length,
      total: rules.length,
      rules: limit ? rules.slice(0, limit) : rules,
      nat: natRules,
      info,
      summary: summaryValue,
    };
  }

  private parsePfctlLines(output: string): string[] {
    if (!output || typeof output !== "string") {
      return [];
    }
    return output
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0);
  }

  private parsePfctlInfoOutput(output: string): Array<{ label: string; value: string }> {
    if (!output || typeof output !== "string") {
      return [];
    }
    return output
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        if (!line.includes(":")) {
          return { label: "info", value: line };
        }
        const [labelRaw, ...rest] = line.split(":");
        const label = (labelRaw ?? "info").trim();
        const value = rest.join(":").trim();
        return { label, value };
      });
  }
}

