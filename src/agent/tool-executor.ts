import type { ToolCall, ExecutionResult, ExecutionContext } from "../types";
import type { BaseTool } from "../tools/BaseTool";
import { logger } from "../utils/logger";

export async function executeToolCall(
  call: ToolCall,
  tools: BaseTool[]
): Promise<ExecutionResult> {
  const tool = tools.find(t => t.metadata.name === call.toolName);

  if (!tool) {
    logger.error(`Tool not found: ${call.toolName}`);
    return { error: `Unknown tool: ${call.toolName}` };
  }

  const context: ExecutionContext = {
    toolName: call.toolName,
    startedAt: Date.now(),
  };

  logger.info(`Executing tool: ${call.toolName}`);
  return tool.execute(call.parameters ?? {}, context);
}

