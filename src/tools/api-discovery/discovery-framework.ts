/**
 * API Discovery Framework
 * 
 * Automated discovery and ingestion of API capabilities for tools.
 * Replaces manual endpoint tracking with runtime discovery and schema generation.
 */

import { z } from "zod";
import type { ToolSchema } from "../tool-schema";
import { pceLogger as logger } from "../../pce/utils/logger";

/**
 * Discovered API endpoint metadata
 */
export interface DiscoveredEndpoint {
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  description?: string;
  parameters?: EndpointParameter[];
  responseSchema?: any;
  category?: string;
  readOnly?: boolean;
  requiresAuth?: boolean;
  rateLimit?: number;
}

/**
 * Endpoint parameter definition
 */
export interface EndpointParameter {
  name: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  required: boolean;
  description?: string;
  enum?: string[];
  default?: any;
}

/**
 * API discovery result
 */
export interface DiscoveryResult {
  service: string;
  baseUrl: string;
  endpoints: DiscoveredEndpoint[];
  discoveredAt: string;
  version?: string;
  metadata?: Record<string, any>;
}

/**
 * Base class for API discovery services
 */
export abstract class ApiDiscoveryService {
  abstract serviceName: string;
  abstract baseUrl: string;

  /**
   * Discover all available API endpoints
   */
  abstract discoverEndpoints(): Promise<DiscoveryResult>;

  /**
   * Test if an endpoint is accessible and what it returns
   */
  abstract probeEndpoint(endpoint: DiscoveredEndpoint): Promise<{
    accessible: boolean;
    responseSchema?: any;
    error?: string;
  }>;

  /**
   * Generate tool action name from endpoint path
   */
  protected generateActionName(endpoint: DiscoveredEndpoint): string {
    // Convert /api/nodes/{node}/qemu/{vmid}/status to get_vm_status
    const parts = endpoint.path
      .replace(/^\/api[^\/]*\//, "") // Remove /api2/json/ or /api/
      .split("/")
      .filter(p => !p.startsWith("{") && p.length > 0);
    
    const methodPrefix = endpoint.method === "GET" ? "get" : 
                        endpoint.method === "POST" ? "create" :
                        endpoint.method === "PUT" ? "update" :
                        endpoint.method === "DELETE" ? "delete" : "action";
    
    // Handle common patterns
    if (parts[parts.length - 1] === "list" || parts[parts.length - 1] === "index") {
      return `list_${parts[parts.length - 2] || parts[0]}`;
    }
    
    const resource = parts[parts.length - 1];
    return `${methodPrefix}_${resource}`.replace(/-/g, "_");
  }

  /**
   * Generate Zod schema from discovered endpoints
   */
  generateActionSchema(endpoints: DiscoveredEndpoint[]): z.ZodObject<any> {
    const actionEnum = z.enum(
      endpoints.map(e => this.generateActionName(e)) as [string, ...string[]]
    );
    
    // Build parameter schema based on endpoint parameters
    const paramFields: Record<string, z.ZodTypeAny> = {
      action: actionEnum.describe("The API action to perform"),
    };

    // Add common optional parameters
    endpoints.forEach(endpoint => {
      const actionName = this.generateActionName(endpoint);
      endpoint.parameters?.forEach(param => {
        if (!param.required && !paramFields[param.name]) {
          // Add as optional parameter
          let zodType: z.ZodTypeAny = z.string();
          
          if (param.type === "number") {
            zodType = z.number();
          } else if (param.type === "boolean") {
            zodType = z.boolean();
          } else if (param.type === "array") {
            zodType = z.array(z.string());
          }
          
          if (param.enum) {
            zodType = z.enum(param.enum as [string, ...string[]]);
          }
          
          paramFields[param.name] = zodType.optional().describe(param.description || param.name);
        }
      });
    });

    return z.object(paramFields);
  }

  /**
   * Generate tool schema from discovery results
   */
  generateToolSchema(discovery: DiscoveryResult, toolName: string, description: string): ToolSchema {
    const actionSchema = this.generateActionSchema(discovery.endpoints);
    
    return {
      name: toolName,
      description,
      parameters: this.zodToJsonSchema(actionSchema),
      examples: this.generateExamples(discovery.endpoints),
      notes: this.generateNotes(discovery),
      categories: this.extractCategories(discovery.endpoints),
    };
  }

  /**
   * Extract categories from endpoints
   */
  protected extractCategories(endpoints: DiscoveredEndpoint[]): string[] {
    const categories = new Set<string>();
    endpoints.forEach(e => {
      if (e.category) {
        categories.add(e.category);
      }
    });
    return Array.from(categories);
  }

  /**
   * Generate usage examples from endpoints
   */
  protected generateExamples(endpoints: DiscoveredEndpoint[]): Array<{
    description: string;
    parameters: Record<string, any>;
  }> {
    return endpoints.slice(0, 5).map(endpoint => ({
      description: endpoint.description || `Call ${endpoint.path}`,
      parameters: {
        action: this.generateActionName(endpoint),
        ...this.extractExampleParams(endpoint),
      },
    }));
  }

  /**
   * Extract example parameters from endpoint
   */
  protected extractExampleParams(endpoint: DiscoveredEndpoint): Record<string, any> {
    const params: Record<string, any> = {};
    endpoint.parameters?.forEach(param => {
      if (param.default !== undefined) {
        params[param.name] = param.default;
      } else if (param.type === "string") {
        params[param.name] = "example";
      } else if (param.type === "number") {
        params[param.name] = 1;
      } else if (param.type === "boolean") {
        params[param.name] = true;
      }
    });
    return params;
  }

  /**
   * Generate notes from discovery results
   */
  protected generateNotes(discovery: DiscoveryResult): string[] {
    const notes: string[] = [];
    notes.push(`Discovered ${discovery.endpoints.length} endpoints from ${discovery.service}`);
    if (discovery.version) {
      notes.push(`API version: ${discovery.version}`);
    }
    const readOnlyCount = discovery.endpoints.filter(e => e.readOnly).length;
    if (readOnlyCount > 0) {
      notes.push(`${readOnlyCount} read-only endpoints`);
    }
    return notes;
  }

  /**
   * Convert Zod schema to JSON Schema (simplified)
   */
  protected zodToJsonSchema(schema: z.ZodObject<any>): any {
    // This is a simplified version - in production, use zod-to-json-schema library
    const shape = schema.shape;
    const properties: Record<string, any> = {};
    const required: string[] = [];

    Object.entries(shape).forEach(([key, value]: [string, any]) => {
      if (value instanceof z.ZodEnum) {
        properties[key] = {
          type: "string",
          enum: value.options,
        };
      } else if (value instanceof z.ZodString) {
        properties[key] = { type: "string" };
      } else if (value instanceof z.ZodNumber) {
        properties[key] = { type: "number" };
      } else if (value instanceof z.ZodBoolean) {
        properties[key] = { type: "boolean" };
      } else if (value instanceof z.ZodOptional) {
        properties[key] = this.zodToJsonSchema(value._def.innerType);
      } else {
        properties[key] = { type: "string" }; // fallback
      }

      if (!(value instanceof z.ZodOptional)) {
        required.push(key);
      }
    });

    return {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    };
  }
}

/**
 * Discovery registry - tracks all discovery services
 */
export class DiscoveryRegistry {
  private services: Map<string, ApiDiscoveryService> = new Map();

  register(service: ApiDiscoveryService): void {
    this.services.set(service.serviceName, service);
    logger.info(`Registered API discovery service: ${service.serviceName}`);
  }

  async discoverAll(): Promise<DiscoveryResult[]> {
    const results: DiscoveryResult[] = [];
    
    for (const [name, service] of this.services.entries()) {
      try {
        logger.info(`Discovering endpoints for ${name}...`);
        const result = await service.discoverEndpoints();
        results.push(result);
        logger.info(`Discovered ${result.endpoints.length} endpoints for ${name}`);
      } catch (error: any) {
        logger.error(`Failed to discover endpoints for ${name}: ${error.message}`);
      }
    }
    
    return results;
  }

  getService(name: string): ApiDiscoveryService | undefined {
    return this.services.get(name);
  }

  listServices(): string[] {
    return Array.from(this.services.keys());
  }
}

// Global registry instance
export const discoveryRegistry = new DiscoveryRegistry();

