import type { RiskLevel } from "../reasoning/intent-classifier";

export type ToolRisk = "low" | "medium" | "high";

const riskOrder: RiskLevel[] = ["READ", "WRITE_LOW", "WRITE_HIGH", "DESTRUCTIVE"];

export function mapToolRiskToIntentRisk(toolRisk: ToolRisk): RiskLevel {
  if (toolRisk === "high") return "WRITE_HIGH";
  if (toolRisk === "medium") return "WRITE_LOW";
  return "READ";
}

export function maxRisk(...risks: RiskLevel[]): RiskLevel {
  let highest: RiskLevel = "READ";
  for (const risk of risks) {
    if (riskOrder.indexOf(risk) > riskOrder.indexOf(highest)) {
      highest = risk;
    }
  }
  return highest;
}

export function deriveToolCallRisk(toolName: string, parameters: Record<string, any>): RiskLevel | undefined {
  const actionValue = String(parameters?.action ?? "").toLowerCase();
  if (toolName === "action" || toolName === "proxmox_write" || toolName === "opnsense_safewrite") {
    if (/(destroy|delete|remove|terminate|kill)/.test(actionValue)) {
      return "DESTRUCTIVE";
    }
    if (/(create|install|configure|set|assign|update)/.test(actionValue)) {
      return "WRITE_HIGH";
    }
    if (/(start|stop|restart|reboot|shutdown)/.test(actionValue)) {
      return "WRITE_LOW";
    }
  }
  return undefined;
}
