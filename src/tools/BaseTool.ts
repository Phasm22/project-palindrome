import type { ToolMetadata, ExecutionResult, ExecutionContext } from "../types";
import type { ToolSchema, DescribableTool } from "./tool-schema";
import type { z } from "zod";

export abstract class BaseTool {
  metadata: ToolMetadata;

  constructor(metadata: ToolMetadata) {
    this.metadata = metadata;
  }

  abstract execute(
    params: Record<string, any>,
    context: ExecutionContext
  ): Promise<ExecutionResult>;
  
  /**
   * Optional: Override this to make the tool self-describing
   * Tools that implement this will automatically appear in the system prompt
   */
  getSchema?(): ToolSchema;
  getParameterSchema?(): z.ZodTypeAny;
}

/**
 * Helper type guard to check if a tool is describable
 */
export function isDescribableTool(tool: BaseTool): tool is DescribableTool {
  return tool.getSchema !== undefined && typeof tool.getSchema === "function";
}

