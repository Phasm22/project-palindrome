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
  traceId?: string; // Links this call back to its parent reasoning trace
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
  // Tools are contractually expected to return { error } rather than throw, but
  // several action handlers (e.g. proxmox_readonly's node_disks/node_network_interfaces
  // param validation) still `throw`. Without this guard, an uncaught rejection here
  // propagates all the way up through the agent loop and aborts the entire turn with
  // "The agent run failed before it completed." instead of surfacing a normal tool
  // error the LLM (or reclassification logic) can react to.
  let result: ExecutionResult;
  try {
    result = await runWithAgentSession(
      executionContext?.sessionId,
      () => tool.execute(call.parameters ?? {}, context)
    );
  } catch (error: any) {
    logger.error(`Tool threw instead of returning an error result: ${call.toolName}`, {
      error: error?.message ?? String(error),
    });
    result = { error: error?.message ?? `${call.toolName} failed unexpectedly` };
  }
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
        traceId: executionContext.traceId,
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
