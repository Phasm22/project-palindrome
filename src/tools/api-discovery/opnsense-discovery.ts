/**
 * OPNsense API Discovery Service
 * 
 * Automatically discovers OPNsense API endpoints by:
 * 1. Using MCP server discovery (if available)
 * 2. Probing common API patterns
 * 3. Querying API documentation endpoints
 * 4. Runtime introspection
 */

import { ApiDiscoveryService, DiscoveredEndpoint, DiscoveryResult } from "./discovery-framework";
import { logger } from "../../utils/logger";
import axios, { AxiosInstance } from "axios";
import https from "https";

export class OpnsenseDiscoveryService extends ApiDiscoveryService {
  serviceName = "opnsense";
  baseUrl: string;
  private apiClient: AxiosInstance;

  constructor(baseUrl: string, apiKey: string, apiSecret: string, verifySsl: boolean = true) {
    super();
    this.baseUrl = baseUrl;
    
    // Create authenticated client
    const httpsAgent = new https.Agent({
      rejectUnauthorized: verifySsl,
    });

    this.apiClient = axios.create({
      baseURL: baseUrl,
      httpsAgent,
      auth: {
        username: apiKey,
        password: apiSecret,
      },
      timeout: 10000,
    });
  }

  /**
   * Discover OPNsense API endpoints
   */
  async discoverEndpoints(): Promise<DiscoveryResult> {
    const endpoints: DiscoveredEndpoint[] = [];

    // Strategy 1: Discover via API module structure
    const moduleEndpoints = await this.discoverViaModules();
    endpoints.push(...moduleEndpoints);

    // Strategy 2: Discover via common patterns
    const patternEndpoints = await this.discoverByPattern();
    endpoints.push(...patternEndpoints);

    // Strategy 3: If MCP server available, use its discovery
    const mcpEndpoints = await this.discoverViaMCP();
    endpoints.push(...mcpEndpoints);

    return {
      service: this.serviceName,
      baseUrl: this.baseUrl,
      endpoints: this.deduplicateEndpoints(endpoints),
      discoveredAt: new Date().toISOString(),
    };
  }

  /**
   * Discover endpoints via OPNsense module structure
   * OPNsense APIs are organized by modules: core, firewall, system, interfaces, etc.
   */
  private async discoverViaModules(): Promise<DiscoveredEndpoint[]> {
    const endpoints: DiscoveredEndpoint[] = [];
    const modules = [
      "core",
      "firewall",
      "system",
      "interfaces",
      "dhcp",
      "diagnostics",
    ];

    for (const module of modules) {
      try {
        // Try common module endpoints
        const moduleEndpoints = await this.probeModule(module);
        endpoints.push(...moduleEndpoints);
      } catch (error) {
        logger.debug(`Could not probe module ${module}`, error);
      }
    }

    return endpoints;
  }

  /**
   * Probe a specific module for available endpoints
   */
  private async probeModule(module: string): Promise<DiscoveredEndpoint[]> {
    const endpoints: DiscoveredEndpoint[] = [];
    const commonActions = ["list", "get", "search", "status", "info"];

    for (const action of commonActions) {
      const paths = [
        `/api/${module}/${action}`,
        `/api/${module}/alias/${action}`,
        `/api/${module}/rule/${action}`,
      ];

      for (const path of paths) {
        try {
          const result = await this.probeEndpoint({
            path,
            method: "GET",
            category: module,
            readOnly: true,
          });

          if (result.accessible) {
            endpoints.push({
              path,
              method: "GET",
              category: module,
              readOnly: true,
              responseSchema: result.responseSchema,
            });
          }
        } catch (error) {
          // Endpoint not available
        }
      }
    }

    return endpoints;
  }

  /**
   * Discover endpoints by probing common patterns
   */
  private async discoverByPattern(): Promise<DiscoveredEndpoint[]> {
    const endpoints: DiscoveredEndpoint[] = [];
    const patterns = [
      // Core endpoints
      { path: "/api/core/systemStatus", method: "GET" as const, category: "system" },
      { path: "/api/core/backup/list", method: "GET" as const, category: "system" },
      
      // Firewall endpoints
      { path: "/api/firewall/alias/searchItem", method: "POST" as const, category: "firewall" },
      { path: "/api/firewall/rule/search", method: "POST" as const, category: "firewall" },
      { path: "/api/firewall/category/search", method: "POST" as const, category: "firewall" },
      
      // Interface endpoints
      { path: "/api/interfaces/list", method: "GET" as const, category: "interfaces" },
      { path: "/api/interfaces/vlan/list", method: "GET" as const, category: "interfaces" },
      
      // DHCP endpoints
      { path: "/api/dhcpv4/leases/searchLease", method: "POST" as const, category: "dhcp" },
      { path: "/api/dhcpv4/lease/list", method: "GET" as const, category: "dhcp" },
      
      // Diagnostics endpoints
      { path: "/api/diagnostics/interface/getArp", method: "GET" as const, category: "diagnostics" },
      { path: "/api/diagnostics/interface/getRoutes", method: "GET" as const, category: "diagnostics" },
    ];

    for (const pattern of patterns) {
      try {
        const result = await this.probeEndpoint({
          ...pattern,
          readOnly: pattern.method === "GET",
        });

        if (result.accessible) {
          endpoints.push({
            ...pattern,
            readOnly: pattern.method === "GET",
            responseSchema: result.responseSchema,
          });
        }
      } catch (error) {
        // Skip unavailable endpoints
      }
    }

    return endpoints;
  }

  /**
   * Discover endpoints via MCP server (if available)
   */
  private async discoverViaMCP(): Promise<DiscoveredEndpoint[]> {
    const endpoints: DiscoveredEndpoint[] = [];
    
    // TODO: Integrate with MCP OPNsense server discovery
    // MCP servers can provide tool definitions that map to API endpoints
    // This would be the most accurate source of truth
    
    return endpoints;
  }

  /**
   * Probe an endpoint to see if it's accessible
   */
  async probeEndpoint(endpoint: DiscoveredEndpoint): Promise<{
    accessible: boolean;
    responseSchema?: any;
    error?: string;
  }> {
    try {
      let response;
      if (endpoint.method === "GET") {
        response = await this.apiClient.get(endpoint.path);
      } else if (endpoint.method === "POST") {
        response = await this.apiClient.post(endpoint.path, {});
      } else {
        return { accessible: false, error: `Method ${endpoint.method} not supported for probing` };
      }

      return {
        accessible: true,
        responseSchema: this.inferSchema(response.data),
      };
    } catch (error: any) {
      if (error.response?.status === 404 || error.response?.status === 403) {
        return { accessible: false, error: error.response.statusText };
      }
      // Some endpoints might require parameters but still exist
      return { accessible: true };
    }
  }

  /**
   * Infer JSON schema from response data
   */
  private inferSchema(data: any): any {
    if (Array.isArray(data)) {
      return {
        type: "array",
        items: data.length > 0 ? this.inferSchema(data[0]) : {},
      };
    } else if (typeof data === "object" && data !== null) {
      const properties: Record<string, any> = {};
      Object.entries(data).forEach(([key, value]) => {
        properties[key] = this.inferSchema(value);
      });
      return { type: "object", properties };
    } else {
      return { type: typeof data };
    }
  }

  /**
   * Deduplicate endpoints by path and method
   */
  private deduplicateEndpoints(endpoints: DiscoveredEndpoint[]): DiscoveredEndpoint[] {
    const seen = new Set<string>();
    return endpoints.filter(e => {
      const key = `${e.method}:${e.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

