import { BaseTool } from "../BaseTool";
import { createToolSchema } from "../tool-helpers";
import { actionRegistry } from "../../actions/registry";
import { SyncDhcpToDnsSchema } from "../../actions/network/sync-dhcp-to-dns";
import { emitToolProgress } from "../../agent/event-bus";
import { pceLogger as logger } from "../../pce/utils/logger";
import type { ToolSchema } from "../tool-schema";
import type { ExecutionContext, ExecutionResult } from "../../types/execution";

export class SyncDhcpToDnsTool extends BaseTool {
  constructor() {
    super({
      name: "action_sync_dhcp_to_dns",
      description:
        "Sync OPNsense DHCP leases to Pi-hole DNS records. " +
        "Bridges the gap between OPNsense DHCP (Unbound) and Pi-hole (forwarder). " +
        "Set dryRun=true to preview without creating or updating records.",
      categories: ["action", "network", "dns", "dhcp"],
      allowedAcls: ["admin", "ops"],
      risk: "medium",
      requiresConfirmation: false,
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, SyncDhcpToDnsSchema, {
      examples: [
        {
          description: "Sync all DHCP leases to DNS",
          parameters: { dryRun: false },
        },
        {
          description: "Preview sync without applying changes",
          parameters: { dryRun: true, updateExisting: true },
        },
      ],
      notes: [
        "Queries OPNsense DHCP leases and creates/updates Pi-hole DNS records",
        "Default domain suffix is '.prox'",
        "Set updateExisting: false to skip records that already exist",
        "Set dryRun: true to preview without creating/updating records",
      ],
    });
  }

  override getParameterSchema() {
    return SyncDhcpToDnsSchema;
  }

  async execute(params: Record<string, any>, _context: ExecutionContext): Promise<ExecutionResult> {
    const started = Date.now();
    const parsed = SyncDhcpToDnsSchema.safeParse(params);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}`, durationMs: Date.now() - started };
    }

    const actionDef = actionRegistry.get("network.sync_dhcp_to_dns")!;
    emitToolProgress({ toolName: "action_sync_dhcp_to_dns", action: "network.sync_dhcp_to_dns", status: "starting", message: "Preparing DHCP-to-DNS sync...", progress: 0.1, details: { params: parsed.data } });
    emitToolProgress({ toolName: "action_sync_dhcp_to_dns", action: "network.sync_dhcp_to_dns", status: "running", message: "Syncing DHCP leases to Pi-hole DNS...", progress: 0.3, details: { step: "opnsense+pihole" } });

    try {
      const result = await actionDef.execute(parsed.data);
      emitToolProgress({ toolName: "action_sync_dhcp_to_dns", action: "network.sync_dhcp_to_dns", status: "completed", message: "DHCP-to-DNS sync completed successfully", progress: 1, details: { result } });
      return { data: result, durationMs: Date.now() - started };
    } catch (error: any) {
      logger.error("action_sync_dhcp_to_dns failed", { error: error.message });
      emitToolProgress({ toolName: "action_sync_dhcp_to_dns", action: "network.sync_dhcp_to_dns", status: "failed", message: `Action failed: ${error.message}`, progress: 0, details: { error: error.message } });
      return { error: error.message || "Action execution failed", durationMs: Date.now() - started };
    }
  }
}
