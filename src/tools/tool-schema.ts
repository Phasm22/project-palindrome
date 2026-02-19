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
  additionalProperties?: boolean | JSONSchemaProperty;
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
  const anyType = zodType as any;
  const def = anyType?._def as Record<string, any> | undefined;

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
    if (Array.isArray(def?.values)) {
      enumValues = def.values;
    } else if (def?.entries && typeof def.entries === "object") {
      // entries is an object like { a: true, b: true } - extract keys
      enumValues = Object.keys(def.entries as Record<string, unknown>);
    }
    
    const prop: JSONSchemaProperty = {
      type: "string",
      enum: enumValues,
      description: zodType.description,
    };
    return prop;
  }

  // Handle ZodNativeEnum (check if it exists first)
  if (def?.typeName === "ZodNativeEnum") {
    const prop: JSONSchemaProperty = {
      type: "string",
      enum: Object.values((def.values ?? {}) as Record<string, unknown>),
      description: zodType.description,
    };
    return prop;
  }

  // Handle ZodOptional
  if (zodType instanceof z.ZodOptional) {
    const innerType = (def?.innerType ?? anyType.unwrap?.()) as z.ZodTypeAny;
    return zodToJsonSchemaProperty(innerType);
  }

  // Handle ZodDefault - unwrap and preserve enum/default
  if (zodType instanceof z.ZodDefault) {
    const innerType = (def?.innerType ?? anyType.removeDefault?.()) as z.ZodTypeAny;
    // Check if inner type is an enum BEFORE unwrapping
    if (innerType instanceof z.ZodEnum) {
      // Zod uses _def.entries (object) or _def.values (array) depending on version
      let enumValues: any[] = [];
      const innerDef = (innerType as any)._def as Record<string, any> | undefined;
      if (Array.isArray(innerDef?.values)) {
        enumValues = innerDef.values;
      } else if (innerDef?.entries && typeof innerDef.entries === "object") {
        // entries is an object like { a: true, b: true } - extract keys
        enumValues = Object.keys(innerDef.entries as Record<string, unknown>);
      }
      
      const prop: JSONSchemaProperty = {
        type: "string",
        enum: enumValues,
        description: innerType.description || zodType.description,
      };
      // defaultValue can be a function or a value
      const defaultFnOrValue = def?.defaultValue;
      const defaultValue = typeof defaultFnOrValue === "function"
        ? defaultFnOrValue()
        : defaultFnOrValue;
      prop.default = defaultValue;
      return prop;
    }
    // For non-enum defaults, unwrap normally
    const prop = zodToJsonSchemaProperty(innerType);
    const defaultFnOrValue = def?.defaultValue;
    const defaultValue = typeof defaultFnOrValue === "function"
      ? defaultFnOrValue()
      : defaultFnOrValue;
    prop.default = defaultValue;
    return prop;
  }

  // Handle ZodArray
  if (zodType instanceof z.ZodArray) {
    const itemType = (def?.type ?? anyType.element ?? z.any()) as z.ZodTypeAny;
    const prop: JSONSchemaProperty = {
      type: "array",
      description: zodType.description,
      items: zodToJsonSchemaProperty(itemType),
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

  // Handle ZodRecord (z.record())
  if (def?.typeName === "ZodRecord" || (zodType as any).constructor?.name === "ZodRecord") {
    const valueType = def?.valueType as z.ZodTypeAny | undefined;
    
    // For ZodRecord, we need to represent it as an object with additionalProperties
    // OpenAI doesn't accept "any" type, so we use a more permissive object schema
    let valueSchema: JSONSchemaProperty;
    if (valueType) {
      valueSchema = zodToJsonSchemaProperty(valueType);
    } else {
      // Fallback: use a permissive schema that accepts any value type
      valueSchema = {
        type: "string", // Default to string, but this is flexible
        description: "Any value type",
      };
    }
    
    return {
      type: "object",
      description: zodType.description || "Record/object with string keys and any values",
      additionalProperties: valueSchema,
    };
  }

  // Handle z.any() - OpenAI doesn't accept "any", so we use object as a fallback
  // Check for ZodAny by checking the typeName or constructor name
  const typeName = def?.typeName;
  const constructorName = (zodType as any).constructor?.name;
  if (typeName === "ZodAny" || constructorName === "ZodAny" || zodType instanceof (z as any).ZodAny) {
    // For z.any(), we return an object type that accepts any properties
    // This is the most compatible with OpenAI's schema requirements
    return {
      type: "object",
      description: zodType.description || "Any object/value",
      additionalProperties: true,
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
