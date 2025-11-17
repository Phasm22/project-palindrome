import type { BaseTool } from "../tools/BaseTool";

export type ToolSession = {
  userId: string;
  aclGroup: string;
};

export function isToolAuthorized(tool: BaseTool, session: ToolSession): boolean {
  if (!tool.metadata.allowedAcls || tool.metadata.allowedAcls.length === 0) {
    return true;
  }
  return tool.metadata.allowedAcls.includes(session.aclGroup);
}

export function getToolRisk(tool: BaseTool): "low" | "medium" | "high" {
  return tool.metadata.risk ?? "low";
}

export function requiresConfirmation(tool: BaseTool): boolean {
  return tool.metadata.requiresConfirmation ?? false;
}
