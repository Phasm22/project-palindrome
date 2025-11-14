import type { ToolMetadata, ExecutionResult, ExecutionContext } from "../types";

export abstract class BaseTool {
  metadata: ToolMetadata;

  constructor(metadata: ToolMetadata) {
    this.metadata = metadata;
  }

  abstract execute(
    params: Record<string, any>,
    context: ExecutionContext
  ): Promise<ExecutionResult>;
}

