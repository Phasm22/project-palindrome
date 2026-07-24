import { AsyncLocalStorage } from "node:async_hooks";
import { actionRegistry } from "../actions/registry";
import type { BaseTool } from "../tools/BaseTool";

export type ToolSession = {
  userId: string;
  aclGroup: string;
};

const toolAclStorage = new AsyncLocalStorage<string>();

export function runWithToolAcl<T>(
  aclGroup: string,
  operation: () => Promise<T>
): Promise<T> {
  return toolAclStorage.run(aclGroup, operation);
}

export function getActiveToolAcl(): string | undefined {
  return toolAclStorage.getStore();
}

export function isToolAuthorized(
  tool: BaseTool,
  session: ToolSession,
  parameters?: Record<string, any>
): boolean {
  if (!tool.metadata.allowedAcls || tool.metadata.allowedAcls.length === 0) {
    return true;
  }
  if (!tool.metadata.allowedAcls.includes(session.aclGroup)) {
    return false;
  }

  if (tool.metadata.name === "action" && typeof parameters?.action === "string") {
    const actionAcl = actionRegistry.get(parameters.action)?.acl;
    if (actionAcl && actionAcl.length > 0) {
      return actionAcl.includes(session.aclGroup);
    }
  }

  return true;
}

export function getToolRisk(tool: BaseTool): "low" | "medium" | "high" {
  return tool.metadata.risk ?? "low";
}

export function requiresConfirmation(tool: BaseTool): boolean {
  return tool.metadata.requiresConfirmation ?? false;
}
