/**
 * Response Formatter
 * 
 * Uses a quick LLM call to format agent responses in a structured, data-oriented style.
 * Transforms verbose LLM responses into concise, bot-like formats similar to:
 * - Firewall rules: "BLOCK | dir=in | src=192.168.71.5 | dst=any"
 * - VM status: structured lists with key metrics
 * - Network info: tabular data formats
 */

import OpenAI from "openai";
import { logger } from "../utils/logger";
import {
  buildEntityListSection,
  parseEntityLine,
  parseEntityListSection,
  type EntityListEntry,
} from "./canonical-response-format";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

export interface FormatContext {
  userQuery: string;
  intentType?: string;
  toolCalls?: Array<{ toolName: string; parameters?: Record<string, any> }>;
  rawData?: any; // Optional raw data from tools for context
  mode?: ResponseMode;
}

export type ResponseMode = "TERSE_DATA" | "ASSISTIVE" | "EXPLAINER";

const MODE_SYSTEM_PROMPTS: Record<ResponseMode, string> = {
  TERSE_DATA: `You are a response formatter that transforms verbose agent responses into structured, data-oriented formats.

Your goal is to make responses more "bot-like" - concise, structured, and focused on the data.

Guidelines:
1. Remove unnecessary pleasantries, explanations, and narrative text
2. Structure data in consistent formats:
   - Firewall rules: "ACTION | dir=direction | src=source | dst=destination | proto=protocol | if=interface"
   - Definitions: "Definition | term=<term> | meaning=\"...\" | context=\"...\""
   - VM/container lists and status/uptime: Use canonical entity-list format: section title, then one line per entity: "- name | Key1=value1 | Key2=value2"
   - Network info: Tabular or pipe-separated formats
   - Status queries: Direct answers with key metrics; for lists of VMs/nodes use entity-list format above
3. Use pipe separators (|) for structured data lists; for entity lists use key=value pairs (e.g. VMID=100 | Uptime=32 days)
4. Keep only essential information
5. If the response is already well-formatted, return it as-is
6. Preserve any structured data formats that are already present
7. Do NOT add explanations or context - just the data

Example transformations:
- "The firewall has the following rules: BLOCK rule for incoming traffic from 192.168.71.5" 
  → "Firewall Rules\nBLOCK | dir=in | src=192.168.71.5 | dst=any"
  
- "VM 101 is running and has 14.36 GB of memory used out of 16 GB total"
  → "VM 101\nStatus: running\nMemory: 14.36 GB / 16 GB"

- "Here are the nodes in the cluster: prox_big, yin, yang"
  → "Cluster Nodes\n- prox_big\n- yin\n- yang"

- "Uptime on proxBig: windowsVM 32 days, opnsense 32 days, ubuntu-cloudinit-8001 0 days"
  → "VM Uptime on proxBig\n- windowsVM | VMID=100 | Uptime=32 days\n- opnsense | VMID=101 | Uptime=32 days\n- ubuntu-cloudinit-8001 | VMID=8001 | Uptime=0 days"

- "List of VMs with status: vm1 running, vm2 stopped"
  → "VMs\n- vm1 | VMID=100 | Status=running\n- vm2 | VMID=101 | Status=stopped"`,
  ASSISTIVE: `You are a concise assistant formatter. Turn tool-heavy responses into a helpful, structured answer.

Format:
Answer: 1 sentence that restates the result.
Evidence: 2-5 short bullets with the strongest signals or facts.
Next steps: 1-3 short bullets (only if relevant).

Guidelines:
1. Keep it succinct and action-oriented
2. Avoid long narratives or speculation
3. If evidence is thin, say "Evidence: Not available"
4. If no next steps are needed, omit the Next steps section
5. If Intent is CHAT_SOCIAL, respond naturally in 1-2 sentences and omit sections`,
  EXPLAINER: `You are a teach-back formatter. Explain the result and provide a short runbook-style guide.

Format:
Answer: 1-2 sentences.
Why this matters: 1-2 sentences.
Runbook: 3-6 short steps, imperative verbs.

Guidelines:
1. Be direct and educational
2. Avoid jargon when possible, but keep technical accuracy
3. Keep it short; do not ramble
4. If a runbook is not applicable, provide 2-3 checks instead`,
};

interface AllowedPortEntry {
  port: number;
  proto: string;
}

interface FirewallRulePortEntry extends AllowedPortEntry {
  direction?: string;
  source?: string;
  destination?: string;
}

interface FirewallRuleEntry {
  action: string;
  direction?: string;
  source?: string;
  destination?: string;
  protocol?: string;
  iface?: string;
  hasPort: boolean;
}

interface PathScope {
  from?: string;
  to?: string;
}

function isVmInventoryQuery(userQuery: string): boolean {
  const query = userQuery.toLowerCase();
  const asksForVmKind = /\b(vm|vms|container|containers|lxc|lxcs)\b/.test(query);
  const asksForList = /\b(list|show|all|running|stopped|currently|inventory)\b/.test(query);
  return asksForVmKind && asksForList;
}

/** True when query asks for status/uptime (of a node, host, or VM list). */
function isStatusListQuery(userQuery: string): boolean {
  const query = userQuery.toLowerCase();
  const asksStatus = /\b(status|uptime|metrics?)\b/.test(query);
  const hasTarget = /\b(of|for)\s+\S+/.test(query) || /\b(on)\s+\S+/.test(query);
  return asksStatus && (hasTarget || /\b(node|host|prox|vm|container)\b/.test(query));
}

function normalizeVmInventoryPackaging(
  responseText: string,
  context: FormatContext
): string | null {
  if (!responseText || !isVmInventoryQuery(context.userQuery)) {
    return null;
  }

  const lines = responseText.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  const headingIndex = lines.findIndex((line) =>
    /^(all\s+.+\b(vms?|containers?|lxc)|cluster\s+vms?|running\s+.+\b(vms?|containers?|lxc)|stopped\s+.+\b(vms?|containers?|lxc)|.*\b(vms?|containers?|lxc)\b.*\bnode\b|\b(?:lxc(?:\s+containers?)?|containers?|vms?)\b.*)$/i.test(
      line.replace(/:$/, "")
    )
  );
  if (headingIndex < 0) return null;

  const hasCanonicalRows = lines.some((line) => /^-\s+.+\((?:VM|LXC|QEMU)/i.test(line));
  const hasInlinePipeRows = lines.some((line) => /^-\s+.+\|\s*status\s*:/i.test(line));

  if (!hasCanonicalRows && !hasInlinePipeRows) {
    return null;
  }

  const rawHeading = lines[headingIndex] ?? "VM inventory";
  const heading = rawHeading.endsWith(":") ? rawHeading : `${rawHeading}:`;
  if (hasCanonicalRows && !hasInlinePipeRows) {
    const normalized = [...lines];
    normalized[headingIndex] = heading;
    return normalized.join("\n");
  }

  const isLxcHeading = /\b(lxc|container)\b/i.test(heading);
  const vmType = isLxcHeading ? "LXC" : "VM";
  const normalizedRows: string[] = [heading];

  for (const line of lines) {
    if (!line.startsWith("- ")) continue;
    const segments = line
      .replace(/^-+\s*/, "")
      .split("|")
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length < 2) continue;

    const name = segments[0] ?? "Unnamed";
    let state = "unknown";
    let node = "";
    let trace = "";
    let source = "";
    const detailParts: string[] = [];

    for (const segment of segments.slice(1)) {
      if (/^status\s*:/i.test(segment)) {
        state = segment.replace(/^status\s*:/i, "").trim() || "unknown";
        continue;
      }
      if (/^details\s*:/i.test(segment)) {
        const detailValue = segment.replace(/^details\s*:/i, "").trim();
        if (detailValue) detailParts.push(detailValue);
        continue;
      }
      if (/^trace\s*[:=]/i.test(segment)) {
        trace = segment.replace(/^trace\s*[:=]/i, "").trim();
        continue;
      }
      if (/^source\s*:/i.test(segment)) {
        source = segment.replace(/^source\s*:/i, "").trim();
        continue;
      }
      if (/^node\s*[:=]/i.test(segment)) {
        node = segment.replace(/^node\s*[:=]/i, "").trim();
        continue;
      }
      detailParts.push(segment);
    }

    if (!node) {
      const nodeFromDetail = detailParts.find((part) => /^node=.+/i.test(part));
      if (nodeFromDetail) node = nodeFromDetail.replace(/^node=/i, "").trim();
    }
    if (!trace) {
      const traceFromDetail = detailParts.find((part) => /^trace=.+/i.test(part));
      if (traceFromDetail) trace = traceFromDetail.replace(/^trace=/i, "").trim();
    }

    const details = [
      node ? `node=${node}` : null,
      trace ? `trace=${trace}` : null,
      ...detailParts.filter((part) => !/^node=/i.test(part) && !/^trace=/i.test(part)),
    ].filter(Boolean) as string[];

    normalizedRows.push(`- ${name} (${vmType}, ${state})`);
    if (details.length > 0) {
      normalizedRows.push(`  - Details: ${details.join(" | ")}`);
    }
    if (source) {
      normalizedRows.push(`  - Source: ${source}`);
    }
  }

  return normalizedRows.length > 1 ? normalizedRows.join("\n") : null;
}

/**
 * Normalize response to canonical entity-list format for status/uptime/compute_list.
 * Runs when intent is status, compute_status, or compute_list, or query is status-list-like.
 */
function normalizeEntityListPackaging(
  responseText: string,
  context: FormatContext
): string | null {
  const intent = context.intentType;
  const useEntityList =
    intent === "status" || intent === "compute_status" || intent === "compute_list" ||
    isStatusListQuery(context.userQuery);
  if (!useEntityList || !responseText) return null;

  const lines = responseText.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  // Already in canonical shape: ensure consistent and return
  const parsed = parseEntityListSection(responseText);
  if (parsed && parsed.entries.length >= 1) {
    return buildEntityListSection(parsed.title, parsed.entries);
  }

  // Try to extract entities from common tool/output shapes
  const entries: EntityListEntry[] = [];
  let sectionTitle = "";

  for (const line of lines) {
    // Canonical-style line with = or : attributes
    const entity = parseEntityLine(line);
    if (entity) {
      entries.push(entity);
      continue;
    }
    // "[vmid] name: status | Memory: ..." (e.g. from list_vms CLI formatter)
    const bracketMatch = line.match(/^\s*\[(\d+)\]\s+(.+?):\s*(.+)$/);
    if (bracketMatch) {
      const [, vmid, name, rest] = bracketMatch;
      const restStr = rest ?? "";
      const attrs: Record<string, string> = { VMID: vmid ?? "" };
      if (restStr.includes("|")) {
        const parts = restStr.split("|").map((p) => p.trim());
        for (const part of parts) {
          const colonIdx = part.indexOf(":");
          if (colonIdx > 0) {
            const k = part.slice(0, colonIdx).trim();
            const v = part.slice(colonIdx + 1).trim();
            if (k && v) attrs[k] = v;
          }
        }
      } else {
        attrs["Status"] = restStr;
      }
      entries.push({ label: (name ?? "").trim(), attributes: attrs });
      continue;
    }
    // "- name (Type, state)" without pipe - treat as single entity
    const parenMatch = line.match(/^-\s+(.+?)\s+\(([^,]+),\s*([^)]+)\)\s*$/);
    if (parenMatch && !line.includes("|")) {
      const [, name, type, state] = parenMatch;
      entries.push({
        label: (name ?? "").trim(),
        attributes: { Type: (type ?? "").trim(), Status: (state ?? "").trim() },
      });
    }
  }

  if (entries.length === 0) return null;

  // Derive title from first non-entity line or query
  const firstNonEntity = lines.find((l) => !parseEntityLine(l) && !l.match(/^\s*\[\d+\]/));
  if (firstNonEntity && !firstNonEntity.startsWith("- ")) {
    sectionTitle = firstNonEntity.replace(/:$/, "").trim();
  }
  if (!sectionTitle) {
    const q = context.userQuery.trim();
    if (/\buptime\b/i.test(q)) sectionTitle = "VM Uptime";
    else if (/\bstatus\b/i.test(q)) sectionTitle = "Status";
    else sectionTitle = "Results";
    const nodeMatch = context.userQuery.match(/\b(of|on|for)\s+(\S+)/i);
    if (nodeMatch?.[2]) sectionTitle += ` on ${nodeMatch[2]}`;
  }

  return buildEntityListSection(sectionTitle, entries);
}

function cleanScopeTerm(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/[.?!,;:]+$/g, "");
  if (!trimmed) return undefined;
  return trimmed.replace(/^(the|an|a)\s+/i, "").trim();
}

function extractPathScopeFromQuery(userQuery: string): PathScope | undefined {
  if (!userQuery) return undefined;
  const normalized = userQuery.trim();
  if (!normalized) return undefined;

  const fromToMatch = normalized.match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?:[.?!]|$)/i);
  if (fromToMatch?.[1] && fromToMatch?.[2]) {
    const from = cleanScopeTerm(fromToMatch[1]);
    const to = cleanScopeTerm(fromToMatch[2]);
    if (from || to) return { from, to };
  }

  const betweenMatch = normalized.match(/\bbetween\s+(.+?)\s+and\s+(.+?)(?:[.?!]|$)/i);
  if (betweenMatch?.[1] && betweenMatch?.[2]) {
    const from = cleanScopeTerm(betweenMatch[1]);
    const to = cleanScopeTerm(betweenMatch[2]);
    if (from || to) return { from, to };
  }

  return undefined;
}

function derivePathScope(
  queryScope: PathScope | undefined,
  observedScope?: { sources?: string[]; destinations?: string[] }
): PathScope | undefined {
  if (queryScope?.from || queryScope?.to) {
    return queryScope;
  }
  const observedFrom = cleanScopeTerm(observedScope?.sources?.[0]);
  const observedTo = cleanScopeTerm(observedScope?.destinations?.[0]);
  if (observedFrom || observedTo) {
    return { from: observedFrom, to: observedTo };
  }
  return undefined;
}

function describePath(scope: PathScope | undefined): string {
  if (scope?.from && scope?.to) {
    return `for traffic from ${scope.from} to ${scope.to}`;
  }
  if (scope?.from) {
    return `for traffic from ${scope.from}`;
  }
  if (scope?.to) {
    return `for traffic to ${scope.to}`;
  }
  return "for this path";
}

function parseAllowedPortEntries(lines: string[]): AllowedPortEntry[] {
  const entries: AllowedPortEntry[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const pipeMatch = line.match(/^-?\s*(\d{1,5})\s*\|\s*proto\s*=\s*(.+)$/i);
    if (pipeMatch?.[1]) {
      entries.push({
        port: Number.parseInt(pipeMatch[1], 10),
        proto: (pipeMatch[2] ?? "").trim(),
      });
      continue;
    }

    const parenMatch = line.match(/^-?\s*(\d{1,5})\s*\(([^)]+)\)\s*$/i);
    if (parenMatch?.[1]) {
      entries.push({
        port: Number.parseInt(parenMatch[1], 10),
        proto: (parenMatch[2] ?? "").trim(),
      });
    }
  }
  return entries.filter((entry) => Number.isFinite(entry.port) && entry.port > 0 && entry.port <= 65535);
}

function extractAliasTerms(lines: string[]): string[] {
  const terms = new Set<string>();
  for (const raw of lines) {
    const line = raw.trim();
    const defMatch = line.match(/^Definition\s*\|\s*term=([^|]+)\|/i);
    if (defMatch?.[1]) {
      terms.add(defMatch[1].trim());
      continue;
    }
    const kvMatch = line.match(/^-+\s*([a-z0-9_:-]+)\s*=\s*/i);
    if (kvMatch?.[1]) {
      terms.add(kvMatch[1].trim());
    }
  }
  return Array.from(terms);
}

function parseFirewallRulePortEntries(lines: string[]): FirewallRulePortEntry[] {
  const entries: FirewallRulePortEntry[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.includes("|") || !/port=\d{1,5}/i.test(line)) {
      continue;
    }
    const head = line.split("|")[0]?.trim().toUpperCase() ?? "";
    if (!head.startsWith("ALLOW") && !head.startsWith("PASS")) {
      continue;
    }

    const portMatch = line.match(/(?:^|\|)\s*port=(\d{1,5})\b/i);
    if (!portMatch?.[1]) {
      continue;
    }
    const port = Number.parseInt(portMatch[1], 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      continue;
    }

    const protoMatch = line.match(/(?:^|\|)\s*proto=([^|]+)\s*(?:\||$)/i);
    const directionMatch = line.match(/(?:^|\|)\s*dir=([^|]+)\s*(?:\||$)/i);
    const srcMatch = line.match(/(?:^|\|)\s*src=([^|]+)\s*(?:\||$)/i);
    const dstMatch = line.match(/(?:^|\|)\s*dst=([^|]+)\s*(?:\||$)/i);

    entries.push({
      port,
      proto: (protoMatch?.[1] ?? "").trim() || "TCP/UDP",
      direction: directionMatch?.[1]?.trim(),
      source: srcMatch?.[1]?.trim(),
      destination: dstMatch?.[1]?.trim(),
    });
  }
  return entries;
}

function parseFirewallRuleEntries(lines: string[]): FirewallRuleEntry[] {
  const entries: FirewallRuleEntry[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.includes("|")) {
      continue;
    }

    const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) {
      continue;
    }
    const action = (parts[0] ?? "").replace(/^-+\s*/, "").toUpperCase();
    if (!["ALLOW", "PASS", "BLOCK", "DENY", "REJECT"].includes(action)) {
      continue;
    }

    const fieldMap = new Map<string, string>();
    for (const part of parts.slice(1)) {
      const eqIndex = part.indexOf("=");
      if (eqIndex < 1) continue;
      const key = part.slice(0, eqIndex).trim().toLowerCase();
      const value = part.slice(eqIndex + 1).trim();
      if (key) {
        fieldMap.set(key, value);
      }
    }

    entries.push({
      action,
      direction: fieldMap.get("dir"),
      source: fieldMap.get("src"),
      destination: fieldMap.get("dst"),
      protocol: fieldMap.get("proto"),
      iface: fieldMap.get("if"),
      hasPort: fieldMap.has("port"),
    });
  }
  return entries;
}

function extractAnomaly(lines: string[]): string | null {
  const anomalyIndex = lines.findIndex((line) => /^anomaly\b/i.test(line));
  if (anomalyIndex !== -1 && lines[anomalyIndex + 1]) {
    return lines[anomalyIndex + 1] ?? null;
  }
  const inline = lines.find((line) => /lack of explicit rules/i.test(line));
  return inline ?? null;
}

function summarizeEntries(entries: AllowedPortEntry[], maxItems = 6): string {
  return entries
    .slice(0, maxItems)
    .map((entry) => `${entry.port}${entry.proto ? ` (${entry.proto})` : ""}`)
    .join(", ");
}

function formatAllowedPortsSummary(
  entries: AllowedPortEntry[],
  aliasTerms: string[],
  scope?: { sources?: string[]; destinations?: string[]; directions?: string[] },
  queryScope?: PathScope
): string {
  const deduped = new Map<number, AllowedPortEntry>();
  for (const entry of entries) {
    if (!deduped.has(entry.port)) {
      deduped.set(entry.port, entry);
    }
  }
  const unique = Array.from(deduped.values()).sort((a, b) => a.port - b.port);
  const managementPorts = new Set([22, 3389, 8006, 5900, 6443, 17875]);
  const management = unique.filter((entry) => managementPorts.has(entry.port));
  const custom = unique.filter(
    (entry) => /custom/i.test(entry.proto) || [3000, 5000, 8080, 8443].includes(entry.port)
  );
  const core = unique.filter((entry) => !management.some((m) => m.port === entry.port) && !custom.some((c) => c.port === entry.port));

  const pathScope = derivePathScope(queryScope, scope);
  const lines: string[] = [
    "Access Summary",
    `${unique.length} inbound service ports are currently allowed ${describePath(pathScope)}.`,
  ];

  if (management.length > 0) {
    lines.push(`Management exposure: ${summarizeEntries(management)}.`);
  }
  if (core.length > 0) {
    lines.push(`Core services: ${summarizeEntries(core)}.`);
  }
  if (custom.length > 0) {
    lines.push(`Custom/app ports: ${summarizeEntries(custom)}.`);
  }
  if (aliasTerms.length > 0) {
    lines.push(`Policy aliases: ${aliasTerms.slice(0, 6).join(", ")}.`);
  }
  if (scope) {
    if (scope.sources && scope.sources.length > 0) {
      lines.push(`Observed source scope: ${scope.sources.slice(0, 3).join(", ")}.`);
    }
    if (scope.destinations && scope.destinations.length > 0) {
      lines.push(`Observed destination scope: ${scope.destinations.slice(0, 3).join(", ")}.`);
    }
    if (scope.directions && scope.directions.length > 0) {
      lines.push(`Observed directions: ${scope.directions.join(", ")}.`);
    }
  }

  lines.push('Ask "show full allowed port list" if you want every port entry.');
  return lines.join("\n");
}

function formatAllowedPortsPolicySummary(
  rules: FirewallRuleEntry[],
  anomaly: string | null,
  queryScope?: PathScope
): string {
  const inbound = rules.filter((rule) => (rule.direction ?? "").toLowerCase() === "in");
  const inboundAllows = inbound.filter((rule) => ["ALLOW", "PASS"].includes(rule.action));
  const inboundBlocks = inbound.filter((rule) => ["BLOCK", "DENY", "REJECT"].includes(rule.action));
  const sourceScopes = Array.from(new Set(inbound.map((rule) => rule.source).filter(Boolean))) as string[];
  const destinationScopes = Array.from(new Set(inbound.map((rule) => rule.destination).filter(Boolean))) as string[];
  const hasExplicitPortAllow = inboundAllows.some((rule) => rule.hasPort);
  const hasBroadAnyAllow = inboundAllows.some(
    (rule) => (rule.protocol ?? "").toLowerCase() === "any" || (rule.iface ?? "").toLowerCase() === "any"
  );
  const pathScope = derivePathScope(queryScope, {
    sources: sourceScopes,
    destinations: destinationScopes,
  });

  const lines: string[] = ["Access Summary"];
  if (hasExplicitPortAllow) {
    lines.push("Inbound allow rules exist, but this response did not include a complete port breakdown.");
  } else {
    lines.push(`No explicit inbound port allow rules were found ${describePath(pathScope)}.`);
  }

  if (hasBroadAnyAllow) {
    lines.push("Observed at least one broad allow condition (`proto=any` and/or `if=any`).");
  }
  lines.push(`Inbound rule mix: allow=${inboundAllows.length}, block=${inboundBlocks.length}.`);

  if (sourceScopes.length > 0) {
    lines.push(`Observed source scope: ${sourceScopes.slice(0, 3).join(", ")}.`);
  }
  if (destinationScopes.length > 0) {
    lines.push(`Observed destination scope: ${destinationScopes.slice(0, 3).join(", ")}.`);
  }
  if (anomaly) {
    lines.push(`Anomaly: ${anomaly}`);
  }
  lines.push('Ask "show full firewall rules for this path" for full rule detail.');
  return lines.join("\n");
}

export function applyAdaptivePackaging(
  responseText: string,
  context: FormatContext
): string | null {
  if (!responseText) return null;

  const vmInventoryPackaging = normalizeVmInventoryPackaging(responseText, context);
  if (vmInventoryPackaging) {
    return vmInventoryPackaging;
  }

  const entityListPackaging = normalizeEntityListPackaging(responseText, context);
  if (entityListPackaging) {
    return entityListPackaging;
  }

  const normalizedQuery = context.userQuery.toLowerCase();
  const wantsFullList =
    /\bshow\b.*\b(full|complete|entire)\b.*\b(list|ports?|rules?)\b/i.test(normalizedQuery) ||
    /\blist\b.*\b(all|every)\b.*\bports?\b/i.test(normalizedQuery);
  if (wantsFullList) {
    return null;
  }

  const lines = responseText.split("\n").map((line) => line.trim()).filter(Boolean);
  const hasAllowedPortsHeading = lines.some((line) => /^allowed ports\b/i.test(line));
  const asksAboutAllowedPorts =
    normalizedQuery.includes("port") &&
    (normalizedQuery.includes("allow") || normalizedQuery.includes("open"));

  if (!hasAllowedPortsHeading && !asksAboutAllowedPorts) {
    return null;
  }
  const queryScope = extractPathScopeFromQuery(context.userQuery);

  const entries = parseAllowedPortEntries(lines);
  if (entries.length >= 6) {
    const aliasTerms = extractAliasTerms(lines);
    return formatAllowedPortsSummary(entries, aliasTerms, undefined, queryScope);
  }

  const firewallRuleEntries = parseFirewallRulePortEntries(lines);
  if (asksAboutAllowedPorts && firewallRuleEntries.length >= 4) {
    const aliasTerms = extractAliasTerms(lines);
    const sources = Array.from(new Set(firewallRuleEntries.map((entry) => entry.source).filter(Boolean))) as string[];
    const destinations = Array.from(new Set(firewallRuleEntries.map((entry) => entry.destination).filter(Boolean))) as string[];
    const directions = Array.from(new Set(firewallRuleEntries.map((entry) => entry.direction).filter(Boolean))) as string[];
    return formatAllowedPortsSummary(
      firewallRuleEntries,
      aliasTerms,
      { sources, destinations, directions },
      queryScope
    );
  }

  const firewallRules = parseFirewallRuleEntries(lines);
  if (asksAboutAllowedPorts && firewallRules.length >= 2) {
    const anomaly = extractAnomaly(lines);
    return formatAllowedPortsPolicySummary(firewallRules, anomaly, queryScope);
  }

  return null;
}

/**
 * Format response using a quick LLM call based on response mode.
 *
 * Modes:
 * - TERSE_DATA: data-oriented, compact formatting
 * - ASSISTIVE: short narrative with evidence + next steps
 * - EXPLAINER: teach-back with runbook-style steps
 */
export async function formatResponseForBot(
  rawResponse: string,
  context: FormatContext
): Promise<string> {
  if (!context.mode) {
    return rawResponse;
  }

  // Skip formatting if disabled
  if (process.env.DISABLE_RESPONSE_FORMATTING === "true") {
    return rawResponse;
  }

  // Skip formatting for very short responses or clarifications
  if (rawResponse.length < 50 || 
      rawResponse.includes("Could you clarify") || 
      rawResponse.includes("I'm not sure") ||
      rawResponse.includes("Max reasoning depth reached")) {
    return rawResponse;
  }

  // Skip formatting for error messages
  if (rawResponse.toLowerCase().includes("error") && 
      (rawResponse.toLowerCase().includes("failed") || 
       rawResponse.toLowerCase().includes("not found"))) {
    return rawResponse;
  }

  const adaptiveRaw = applyAdaptivePackaging(rawResponse, context);
  if (adaptiveRaw) {
    return adaptiveRaw;
  }

  try {
    const client = getOpenAIClient();
    
    // Build context about what tools were used and what data was retrieved
    let toolContext = "";
    if (context.toolCalls && context.toolCalls.length > 0) {
      const toolNames = context.toolCalls.map(tc => tc.toolName).join(", ");
      toolContext = `Tools used: ${toolNames}`;
    }

    // Build intent context
    let intentContext = "";
    if (context.intentType) {
      intentContext = `Intent: ${context.intentType}`;
    }

    const systemPrompt = MODE_SYSTEM_PROMPTS[context.mode];

    const preserveAliasDefs = context.intentType === "firewall_rules" && rawResponse.includes("Alias definitions:");
    const aliasSection = preserveAliasDefs
      ? rawResponse.slice(rawResponse.indexOf("Alias definitions:"))
      : "";

    const entityListIntents = ["status", "compute_status", "compute_list"];
    const useEntityListFormat =
      context.intentType && entityListIntents.includes(context.intentType);
    const formatInstruction = useEntityListFormat
      ? " Use the canonical entity-list format: a section title on the first line, then one line per item: - name | Key1=value1 | Key2=value2 (e.g. VMID=100 | Uptime=32 days)."
      : "";

    const userPrompt = `Original response to format:
${rawResponse}

${intentContext ? `${intentContext}\n` : ""}${toolContext ? `${toolContext}\n` : ""}
User query: "${context.userQuery}"

Format this response in a structured, data-oriented style. Return only the formatted response, no explanations.${formatInstruction}${preserveAliasDefs ? " IMPORTANT: Keep the entire 'Alias definitions:' section at the end unchanged (do not truncate or summarize it)." : ""}`;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini", // Use fast, cheap model for formatting
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1, // Low temperature for consistent formatting
      max_tokens: 4000, // Enough for rules + full alias definitions
    });

    let formatted = response.choices[0]?.message?.content?.trim() || rawResponse;
    if (preserveAliasDefs && aliasSection && !formatted.includes("Alias definitions:")) {
      formatted = formatted.trimEnd() + "\n\n" + aliasSection;
    }

    const adaptiveFormatted = applyAdaptivePackaging(formatted, context);
    if (adaptiveFormatted) {
      formatted = adaptiveFormatted;
    }
    
    logger.debug("Response formatted", {
      originalLength: rawResponse.length,
      formattedLength: formatted.length,
      intentType: context.intentType,
      mode: context.mode,
    });

    return formatted;
  } catch (error: any) {
    // If formatting fails, return original response
    logger.warn("Response formatting failed, returning original", {
      error: error.message,
    });
    return rawResponse;
  }
}

/**
 * Quick intent detection for response formatting
 * Helps the formatter understand what kind of data it's formatting
 */
export function detectResponseIntent(
  userQuery: string,
  toolCalls?: Array<{ toolName: string; parameters?: Record<string, any> }>
): string | undefined {
  const query = userQuery.toLowerCase();
  
  // Check tool calls first (most reliable)
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      if (tc.toolName === "twin_query" || tc.toolName === "opnsense_readonly") {
        const op = tc.parameters?.operation || tc.parameters?.action || "";
        if (op.includes("firewall")) return "firewall_rules";
        if (op.includes("temperature") || op.includes("temp")) return "temperature";
        if (op.includes("vm") || op.includes("container")) return "compute_status";
        if (op.includes("network") || op.includes("interface")) return "network_info";
      }
      if (tc.toolName === "proxmox_readonly") {
        const action = tc.parameters?.action || "";
        if (action.includes("list_vms") || action.includes("list_containers")) return "compute_list";
        if (action.includes("node") || action.includes("cluster")) return "cluster_status";
      }
    }
  }
  
  // Fallback to query analysis
  if (query.includes("firewall") || query.includes("rule")) return "firewall_rules";
  if (query.includes("temperature") || query.includes("temp")) return "temperature";
  if (query.includes("vm") || query.includes("container")) return "compute_status";
  if (query.includes("network") || query.includes("interface") || query.includes("subnet")) return "network_info";
  if (query.includes("status") || query.includes("uptime")) return "status";
  if (query.includes("list") || query.includes("show")) return "list";
  
  return undefined;
}
