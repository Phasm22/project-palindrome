import type { ToolCall, ExecutionResult, ExecutionContext, ACLGroup } from "../types";
import type { BaseTool } from "../tools/BaseTool";
import { logger } from "../utils/logger";
import { getToolExecutionStore } from "../pce/api/tool-execution-store";
import { runWithAgentSession } from "./event-bus";

export interface ToolExecutionContext {
  userId?: string;
  aclGroup?: ACLGroup;
  node?: string; // For Proxmox operations
  vmid?: number; // For VM operations
  sessionId?: string;
}

export async function executeToolCall(
  call: ToolCall,
  tools: BaseTool[],
  executionContext?: ToolExecutionContext
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
  
  const startTime = Date.now();
  const result = await runWithAgentSession(
    executionContext?.sessionId,
    () => tool.execute(call.parameters ?? {}, context)
  );
  const durationMs = Date.now() - startTime;
  
  // Record execution for dashboard (if context provided)
  if (executionContext?.userId) {
    try {
      const rawError = result.error;
      const storedError =
        rawError != null && (String(rawError).trim().length < 10 || /^\s*[.\s]*$/.test(String(rawError)))
          ? `${call.toolName} failed: ${rawError}`
          : rawError ?? undefined;

      const store = getToolExecutionStore();
      await store.recordExecution({
        toolName: call.toolName,
        parameters: call.parameters ?? {},
        result: storedError !== undefined ? { ...result, error: storedError } : result,
        userId: executionContext.userId,
        aclGroup: executionContext.aclGroup || "viewer",
        durationMs,
        timestamp: new Date(),
        node: executionContext.node,
        vmid: executionContext.vmid,
        error: storedError,
      });
    } catch (error: any) {
      // Don't fail tool execution if audit logging fails
      logger.warn("Failed to record tool execution for dashboard", {
        error: error.message,
        toolName: call.toolName,
      });
    }
  }
  
  if (result.error) {
    logger.error(`Tool execution failed: ${call.toolName}`, {
      error: result.error,
    });
  }
  
  return result;
}
