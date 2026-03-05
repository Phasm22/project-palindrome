import { BaseTool } from "../BaseTool";
import { createToolSchema } from "../tool-helpers";
import { actionRegistry } from "../../actions/registry";
import { CreateDnsRecordSchema } from "../../actions/network/create-dns-record";
import { emitToolProgress } from "../../agent/event-bus";
import { pceLogger as logger } from "../../pce/utils/logger";
import type { ToolSchema } from "../tool-schema";
import type { ExecutionContext, ExecutionResult } from "../../types/execution";

export class CreateDnsRecordTool extends BaseTool {
  constructor() {
    super({
      name: "action_create_dns_record",
      description:
        "Create a DNS A record in Pi-hole for a hostname and IP address. " +
        "The default domain suffix is '.prox'. " +
        "Set dryRun=true to preview without creating the record.",
      categories: ["action", "network", "dns", "pihole"],
      allowedAcls: ["admin", "ops"],
      risk: "medium",
      requiresConfirmation: false,
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, CreateDnsRecordSchema, {
      examples: [
        {
          description: "Create a DNS record for a new VM",
          parameters: { hostname: "web-server", ip: "172.16.50.100", domain: ".prox", dryRun: false },
        },
        {
          description: "Preview DNS record creation",
          parameters: { hostname: "my-service", ip: "192.168.1.50", dryRun: true },
        },
      ],
      notes: [
        "hostname should not include the domain suffix — it is appended automatically",
        "Default domain is '.prox' — override with domain parameter",
        "Set dryRun: true to preview without creating the record",
      ],
    });
  }

  override getParameterSchema() {
    return CreateDnsRecordSchema;
  }

  async execute(params: Record<string, any>, _context: ExecutionContext): Promise<ExecutionResult> {
    const started = Date.now();
    const parsed = CreateDnsRecordSchema.safeParse(params);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}`, durationMs: Date.now() - started };
    }

    const actionDef = actionRegistry.get("network.create_dns_record")!;
    emitToolProgress({ toolName: "action_create_dns_record", action: "network.create_dns_record", status: "starting", message: "Preparing DNS record creation...", progress: 0.1, details: { params: parsed.data } });
    emitToolProgress({ toolName: "action_create_dns_record", action: "network.create_dns_record", status: "running", message: "Creating DNS record in Pi-hole...", progress: 0.3, details: { step: "pihole" } });

    try {
      const result = await actionDef.execute(parsed.data);
      emitToolProgress({ toolName: "action_create_dns_record", action: "network.create_dns_record", status: "completed", message: "DNS record created successfully", progress: 1, details: { result } });
      return { data: result, durationMs: Date.now() - started };
    } catch (error: any) {
      logger.error("action_create_dns_record failed", { error: error.message });
      emitToolProgress({ toolName: "action_create_dns_record", action: "network.create_dns_record", status: "failed", message: `Action failed: ${error.message}`, progress: 0, details: { error: error.message } });
      return { error: error.message || "Action execution failed", durationMs: Date.now() - started };
    }
  }
}
