/**
 * Tool Schema System - Self-describing tools for auto-discovery
 * 
 * This system allows tools to describe themselves using Zod schemas,
 * which are automatically converted to JSON Schema for LLM consumption.
 * Similar to OpenAI Function Calling and MCP (Model Context Protocol).
 */

import { z } from "zod";
import type { BaseTool } from "./BaseTool";
import type { ToolMetadata } from "../types";

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JSONSchema;
  examples?: Array<{
    description?: string;
    parameters: Record<string, any>;
  }>;
  notes?: string[];
  categories?: string[];
}

export interface JSONSchema {
  type: "object";
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: any[];
  default?: any;
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
}

/**
 * Converts a Zod schema to JSON Schema
 * This is a simplified version - for production, consider using zod-to-json-schema
 */
export function zodToJsonSchema(zodSchema: z.ZodTypeAny): JSONSchema {
  if (zodSchema instanceof z.ZodObject) {
    const shape = zodSchema.shape;
    const properties: Record<string, JSONSchemaProperty> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      const prop = zodToJsonSchemaProperty(value as z.ZodTypeAny);
      properties[key] = prop;
      
      // Check if field is optional
      if (!(value instanceof z.ZodOptional || value instanceof z.ZodDefault)) {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
      additionalProperties: false,
    };
  }

  // Fallback for non-object schemas
  return {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
}

function zodToJsonSchemaProperty(zodType: z.ZodTypeAny): JSONSchemaProperty {
  // Handle ZodString
  if (zodType instanceof z.ZodString) {
    const prop: JSONSchemaProperty = {
      type: "string",
      description: zodType.description,
    };
    return prop;
  }

  // Handle ZodNumber
  if (zodType instanceof z.ZodNumber) {
    const prop: JSONSchemaProperty = {
      type: "number",
      description: zodType.description,
    };
    return prop;
  }

  // Handle ZodBoolean
  if (zodType instanceof z.ZodBoolean) {
    const prop: JSONSchemaProperty = {
      type: "boolean",
      description: zodType.description,
    };
    return prop;
  }

  // Handle ZodEnum
  if (zodType instanceof z.ZodEnum) {
    // Zod uses _def.entries (object) or _def.values (array) depending on version
    let enumValues: any[] = [];
    if (zodType._def.values) {
      enumValues = zodType._def.values;
    } else if (zodType._def.entries) {
      // entries is an object like { a: true, b: true } - extract keys
      enumValues = Object.keys(zodType._def.entries);
    }
    
    const prop: JSONSchemaProperty = {
      type: "string",
      enum: enumValues,
      description: zodType.description,
    };
    return prop;
  }

  // Handle ZodNativeEnum (check if it exists first)
  if (zodType._def?.typeName === "ZodNativeEnum") {
    const prop: JSONSchemaProperty = {
      type: "string",
      enum: Object.values(zodType._def.values),
      description: zodType.description,
    };
    return prop;
  }

  // Handle ZodOptional
  if (zodType instanceof z.ZodOptional) {
    return zodToJsonSchemaProperty(zodType._def.innerType);
  }

  // Handle ZodDefault - unwrap and preserve enum/default
  if (zodType instanceof z.ZodDefault) {
    const innerType = zodType._def.innerType;
    // Check if inner type is an enum BEFORE unwrapping
    if (innerType instanceof z.ZodEnum) {
      // Zod uses _def.entries (object) or _def.values (array) depending on version
      let enumValues: any[] = [];
      if (innerType._def.values) {
        enumValues = innerType._def.values;
      } else if (innerType._def.entries) {
        // entries is an object like { a: true, b: true } - extract keys
        enumValues = Object.keys(innerType._def.entries);
      }
      
      const prop: JSONSchemaProperty = {
        type: "string",
        enum: enumValues,
        description: innerType.description || zodType.description,
      };
      // defaultValue can be a function or a value
      const defaultValue = typeof zodType._def.defaultValue === "function" 
        ? zodType._def.defaultValue() 
        : zodType._def.defaultValue;
      prop.default = defaultValue;
      return prop;
    }
    // For non-enum defaults, unwrap normally
    const prop = zodToJsonSchemaProperty(innerType);
    const defaultValue = typeof zodType._def.defaultValue === "function" 
      ? zodType._def.defaultValue() 
      : zodType._def.defaultValue;
    prop.default = defaultValue;
    return prop;
  }

  // Handle ZodArray
  if (zodType instanceof z.ZodArray) {
    const prop: JSONSchemaProperty = {
      type: "array",
      description: zodType.description,
      items: zodToJsonSchemaProperty(zodType._def.type),
    };
    return prop;
  }

  // Handle ZodObject (nested)
  if (zodType instanceof z.ZodObject) {
    const shape = zodType.shape;
    const properties: Record<string, JSONSchemaProperty> = {};
    
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchemaProperty(value as z.ZodTypeAny);
    }

    return {
      type: "object",
      description: zodType.description,
      properties,
    };
  }

  // Fallback
  return {
    type: "string",
    description: zodType.description,
  };
}

/**
 * Extended tool interface that includes schema information
 */
export interface DescribableTool extends BaseTool {
  getSchema(): ToolSchema;
  getParameterSchema(): z.ZodTypeAny;
}

/**
 * Helper to check if a tool is describable
 */
export function isDescribableTool(tool: BaseTool): tool is DescribableTool {
  return "getSchema" in tool && typeof (tool as any).getSchema === "function";
}

/**
 * Generates a tool description string from a ToolSchema
 * This is used in the system prompt
 */
export function formatToolDescription(schema: ToolSchema): string {
  let desc = `- ${schema.name}: ${schema.description}\n`;
  
  // Parameters
  const paramDesc = formatJsonSchema(schema.parameters);
  desc += `  Parameters: ${paramDesc}\n`;
  
  // Examples
  if (schema.examples && schema.examples.length > 0) {
    desc += `  Examples:\n`;
    for (const example of schema.examples) {
      if (example.description) {
        desc += `    - ${example.description}: ${JSON.stringify({ tool: schema.name, parameters: example.parameters })}\n`;
      } else {
        desc += `    - ${JSON.stringify({ tool: schema.name, parameters: example.parameters })}\n`;
      }
    }
  }
  
  // Notes
  if (schema.notes && schema.notes.length > 0) {
    desc += `  Notes:\n`;
    for (const note of schema.notes) {
      desc += `    - ${note}\n`;
    }
  }
  
  return desc;
}

function formatJsonSchema(schema: JSONSchema): string {
  const parts: string[] = [];
  
  for (const [key, prop] of Object.entries(schema.properties)) {
    let part = `${key}: `;
    
    if (prop.enum) {
      part += prop.enum.map(v => JSON.stringify(v)).join("|");
    } else if (prop.type === "object" && prop.properties) {
      part += formatJsonSchema({ type: "object", properties: prop.properties });
    } else {
      part += prop.type;
    }
    
    if (prop.default !== undefined) {
      part += ` (default: ${JSON.stringify(prop.default)})`;
    }
    
    if (!schema.required?.includes(key)) {
      part += " (optional)";
    }
    
    parts.push(part);
  }
  
  return `{${parts.join(", ")}}`;
}

/**
 * Generates the tools section of the system prompt from all available tools
 */
export function generateToolsPrompt(tools: BaseTool[]): string {
  const describableTools = tools.filter(isDescribableTool);
  
  if (describableTools.length === 0) {
    return "No tools available.";
  }
  
  let prompt = "Available tools:\n";
  
  for (const tool of describableTools) {
    const schema = tool.getSchema();
    prompt += formatToolDescription(schema);
    prompt += "\n";
  }
  
  return prompt.trim();
}

