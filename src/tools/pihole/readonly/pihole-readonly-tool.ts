import { PiholeReadOnlyBase } from "./base";
import { z } from "zod";
import type { ToolSchema } from "../../tool-schema";
import { createToolSchema } from "../../tool-helpers";
import type { ExecutionResult, ExecutionContext } from "../../../types/execution";

/**
 * Schema for Pi-hole read-only tool parameters.
 * Covers DNS record listing, aggregate stats (top domains/clients, query
 * types, summary), query-log search, and blocking status — everything a
 * Pi-hole admin dashboard can answer that this agent previously had no
 * tool for at all.
 */
export const PiholeReadOnlyParams = z.object({
  action: z.enum([
    "dns_records_list",
    "dns_summary_stats",
    "dns_top_domains",
    "dns_top_blocked_domains",
    "dns_top_clients",
    "dns_query_types",
    "dns_query_log_search",
    "dns_blocking_status",
  ]).describe("The read-only Pi-hole DNS operation to perform"),

  domain: z.string().optional().describe("Filter by domain, for dns_query_log_search"),
  client_ip: z.string().optional().describe("Filter by client IP address, for dns_query_log_search"),
  query_type: z.string().optional().describe("Filter by DNS record type (A, AAAA, PTR, HTTPS, etc.), for dns_query_log_search"),
  count: z.number().optional().describe("Number of top results to return, for dns_top_domains/dns_top_blocked_domains/dns_top_clients"),
  length: z.number().optional().describe("Max number of query-log rows to return, for dns_query_log_search"),
  from: z.number().optional().describe("Unix timestamp (seconds): start of the query-log time window, for dns_query_log_search"),
  until: z.number().optional().describe("Unix timestamp (seconds): end of the query-log time window, for dns_query_log_search"),
});

export type PiholeReadOnlyParams = z.infer<typeof PiholeReadOnlyParams>;

/**
 * Unified Pi-hole Read-Only Tool.
 * DNS is served by Pi-hole in this environment, not OPNsense — this is the
 * only tool that can answer DNS/blocklist/query-log questions.
 */
export class PiholeReadOnlyTool extends PiholeReadOnlyBase {
  constructor() {
    super({
      name: "pihole_readonly",
      description:
        "Pi-hole DNS read-only tool. DNS is served by Pi-hole in this environment, not OPNsense — " +
        "use this tool (not opnsense_readonly or ssh_execute) for any DNS, blocklist, or query-log question: " +
        "custom DNS records, top/blocked domains, top clients by query volume, query type breakdown, " +
        "query-log search, and whether blocking is currently enabled.",
      categories: ["pihole", "dns", "networking"],
      allowedAcls: ["admin", "ops", "viewer"],
      risk: "low",
      classification: [
        {
          domain: "dns",
          triggerPatterns: [
            /\b(dns|pi-?hole|blocklist|block\s?list|blocked\s?domains?|top\s+domains|top\s+clients|dns\s?record|query\s?log|gravity)\b/i,
          ],
          classificationExamples: ["show me all DNS records"],
          retrievalKeywords: ["dns", "pihole", "pi-hole", "blocklist", "query log", "gravity"],
          toolFirst: true,
          compositeEligible: true,
          priority: 100,
        },
      ],
    });
  }

  override getSchema(): ToolSchema {
    return createToolSchema(this, PiholeReadOnlyParams, {
      examples: [
        {
          description: "List custom DNS records",
          parameters: { action: "dns_records_list" },
        },
        {
          description: "Overall DNS summary (queries today, percent blocked, gravity size)",
          parameters: { action: "dns_summary_stats" },
        },
        {
          description: "Top 10 most-queried domains",
          parameters: { action: "dns_top_domains", count: 10 },
        },
        {
          description: "Top 10 most-blocked domains",
          parameters: { action: "dns_top_blocked_domains", count: 10 },
        },
        {
          description: "Which clients generate the most DNS queries",
          parameters: { action: "dns_top_clients", count: 10 },
        },
        {
          description: "Query type breakdown (A, AAAA, PTR, HTTPS, ...)",
          parameters: { action: "dns_query_types" },
        },
        {
          description: "Search the query log for a specific domain",
          parameters: { action: "dns_query_log_search", domain: "example.com", length: 20 },
        },
        {
          description: "Search the query log for a specific client",
          parameters: { action: "dns_query_log_search", client_ip: "172.16.0.100", length: 20 },
        },
        {
          description: "Is DNS blocking currently enabled",
          parameters: { action: "dns_blocking_status" },
        },
      ],
      notes: [
        "DNS is served by Pi-hole, not OPNsense — use this tool, not opnsense_readonly or ssh_execute, for DNS/blocklist/query-log questions.",
        "dns_top_domains/dns_top_clients return pre-aggregated data in one call — do not fetch dns_query_log_search and count client-side.",
        "dns_top_blocked_domains is dns_top_domains restricted to blocked queries only — pass blocked implicitly via this action, not a separate flag.",
        "dns_top_domains/dns_top_blocked_domains/dns_top_clients return total_queries and blocked_queries as lab-wide totals across ALL domains/clients, sibling fields next to the domains/clients array — they are NOT attributes of any single listed domain/client. Report them separately (e.g. 'lab-wide: N total, M blocked') rather than alongside a specific domain's count, or it reads as if that one domain accounted for the whole total.",
        "There is no standalone 'is domain X on the blocklist' check — that would only cover custom lists, not the full external gravity blocklist. " +
          "To answer 'is domain X blocked', use dns_query_log_search with that domain and inspect the returned status field: " +
          "GRAVITY/DENYLIST/REGEX/EXTERNAL_BLOCKED_* means it was blocked; FORWARDED/CACHE/etc. means it was allowed. " +
          "If there are no recent queries for that domain, say so explicitly rather than guessing.",
        "dns_blocking_status reports whether Pi-hole blocking is globally enabled/disabled — it is NOT a per-domain check.",
        "All operations are strictly read-only. Write operations (creating/deleting DNS records) are not available through this tool.",
        "Query-log stats reflect Pi-hole's current in-memory window, not a full historical archive — for long-range trends, note that limitation in the answer.",
      ],
    });
  }

  override getParameterSchema() {
    return PiholeReadOnlyParams;
  }

  async execute(params: Record<string, any>, context: ExecutionContext): Promise<ExecutionResult> {
    const parsed = PiholeReadOnlyParams.safeParse(params);
    if (!parsed.success) {
      return { error: `Invalid parameters: ${parsed.error.message}` };
    }

    const readOnlyCheck = this.validateReadOnly(parsed.data.action);
    if (readOnlyCheck) {
      return readOnlyCheck;
    }

    return this.executeApiCall(() => this.handleAction(parsed.data), context);
  }

  private async handleAction(params: PiholeReadOnlyParams): Promise<any> {
    const client = this.getClient();

    switch (params.action) {
      case "dns_records_list":
        return client.listDnsRecords();
      case "dns_summary_stats":
        return client.getStatistics();
      case "dns_top_domains":
        return client.getTopDomains({ count: params.count });
      case "dns_top_blocked_domains":
        return client.getTopDomains({ blocked: true, count: params.count });
      case "dns_top_clients":
        return client.getTopClients({ count: params.count });
      case "dns_query_types":
        return client.getQueryTypes();
      case "dns_query_log_search":
        return client.searchQueries({
          domain: params.domain,
          clientIp: params.client_ip,
          type: params.query_type,
          from: params.from,
          until: params.until,
          length: params.length,
        });
      case "dns_blocking_status":
        return client.getBlockingStatus();
      default:
        throw new Error(`Unknown action: ${params.action}`);
    }
  }
}
