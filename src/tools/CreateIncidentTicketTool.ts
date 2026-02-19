import { randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { BaseTool } from "./BaseTool";
import {
  CreateIncidentTicketParams,
  CreateIncidentTicketJSONSchema,
  type CreateIncidentTicketParamsType,
} from "./schemas/incident";
import type { ExecutionContext, ExecutionResult } from "../types";

function resolveIncidentLogPath() {
  return process.env.PCE_INCIDENT_LOG_PATH
    ? path.resolve(process.env.PCE_INCIDENT_LOG_PATH)
    : path.join(process.cwd(), ".pce", "incidents.jsonl");
}

export class CreateIncidentTicketTool extends BaseTool {
  constructor() {
    super({
      name: "create_incident_ticket",
      description: "Opens an incident ticket with severity, tagging, and auto-notify hooks",
      categories: ["incident", "workflow"],
      parameters: CreateIncidentTicketJSONSchema,
      allowedAcls: ["admin", "ops"],
      risk: "high",
      requiresConfirmation: true,
    });
  }

  async execute(params: Record<string, any>, context: ExecutionContext): Promise<ExecutionResult> {
    const parsed = CreateIncidentTicketParams.safeParse(params);
    if (!parsed.success) {
      return { error: parsed.error.message };
    }

    const started = context.startedAt ?? Date.now();
    const payload = parsed.data;
    const ticket = this.buildTicket(payload);

    try {
      await this.persist(ticket);
      return {
        data: ticket,
        durationMs: Date.now() - started,
      };
    } catch (error: any) {
      return {
        error: error.message ?? "Failed to persist incident ticket",
        durationMs: Date.now() - started,
      };
    }
  }

  private buildTicket(payload: CreateIncidentTicketParamsType): Record<string, any> {
    const now = new Date().toISOString();
    const ticketId = `INC-${now.replace(/[-:TZ]/g, "").slice(0, 12)}-${randomUUID().slice(0, 6)}`;
    const severityWeights: Record<CreateIncidentTicketParamsType["severity"], number> = {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
    };

    const priorityScore = severityWeights[payload.severity] * (1 + payload.tags.length * 0.1);
    const slaMinutes = ["low", "medium"].includes(payload.severity) ? 240 : payload.severity === "high" ? 60 : 15;

    return {
      ticketId,
      status: "OPEN",
      createdAt: now,
      title: payload.title,
      description: payload.description,
      severity: payload.severity,
      service: payload.service,
      assignedTo: payload.assignedTo ?? "on-call",
      tags: payload.tags,
      autoNotify: payload.autoNotify,
      linkedRunbook: payload.linkedRunbook ?? null,
      priorityScore: Number(priorityScore.toFixed(2)),
      slaMinutes,
      auditTrail: [
        {
          state: "OPENED",
          actor: "automation",
          at: now,
        },
      ],
    };
  }

  private async persist(ticket: Record<string, any>) {
    const logPath = resolveIncidentLogPath();
    const dir = path.dirname(logPath);
    await mkdir(dir, { recursive: true });
    await appendFile(logPath, JSON.stringify(ticket) + "\n");
  }
}
