/**
 * Tool Helper Functions
 * 
 * Reduces boilerplate when creating tool schemas while maintaining quality.
 */

import type { BaseTool } from "./BaseTool";
import type { ToolSchema } from "./tool-schema";
import { zodToJsonSchema } from "./tool-schema";
import type { z } from "zod";

export interface CreateToolSchemaOptions {
  /**
   * Usage examples for the tool.
   * These help the LLM understand when and how to use the tool.
   */
  examples?: Array<{
    description?: string;
    parameters: Record<string, any>;
  }>;
  
  /**
   * Important notes about the tool.
   * Use for constraints, warnings, or additional context.
   */
  notes?: string[];
}

/**
 * Creates a ToolSchema from a tool and its Zod parameter schema.
 * 
 * This helper reduces boilerplate by automatically:
 * - Using the tool's metadata (name, description, categories)
 * - Converting the Zod schema to JSON Schema
 * - Applying optional examples and notes
 * 
 * @example
 * ```typescript
 * getSchema(): ToolSchema {
 *   return createToolSchema(this, GlancesParams, {
 *     examples: [
 *       { description: "Get all metrics", parameters: { section: "all" } },
 *       { description: "Get CPU metrics", parameters: { section: "cpu" } }
 *     ]
 *   });
 * }
 * ```
 */
export function createToolSchema(
  tool: BaseTool,
  parameterSchema: z.ZodObject<any>,
  options?: CreateToolSchemaOptions
): ToolSchema {
  return {
    name: tool.metadata.name,
    description: tool.metadata.description,
    parameters: zodToJsonSchema(parameterSchema),
    examples: options?.examples || [],
    notes: options?.notes || [],
    categories: tool.metadata.categories,
  };
}

