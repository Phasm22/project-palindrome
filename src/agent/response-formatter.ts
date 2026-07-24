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
import { parseFilterRule } from "../reasoning/chains/firewall";
import { MODE_INSTRUCTIONS } from "./system-prompt";

interface EntityListEntry {
  label: string;
  attributes: Record<string, string>;
}

function buildEntityLine(label: string, attributes: Record<string, string>): string {
  const pairs = Object.entries(attributes)
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => `${k}=${String(v).trim()}`);
  if (pairs.length === 0) return `- ${label}`;
  return `- ${label} | ${pairs.join(" | ")}`;
}

function buildEntityListSection(title: string, entries: EntityListEntry[]): string {
  const lines = [title.trim().replace(/:$/, "")];
  for (const e of entries) {
    lines.push(buildEntityLine(e.label, e.attributes));
  }
  return lines.join("\n");
}

function parseEntityLine(line: string): EntityListEntry | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("- ") || !trimmed.includes("|")) return null;
  const rest = trimmed.slice(2).trim();
  const segments = rest.split("|").map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return null;
  const label = segments[0] ?? "";
  const attributes: Record<string, string> = {};
  for (const segment of segments.slice(1)) {
    const eqIdx = segment.indexOf("=");
    const colonIdx = segment.indexOf(":");
    if (eqIdx > 0) {
      const key = segment.slice(0, eqIdx).trim();
      let value = segment.slice(eqIdx + 1).trim();
      value = value.replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"');
      if (key) attributes[key] = value;
    } else if (colonIdx > 0) {
      const key = segment.slice(0, colonIdx).trim();
      const value = segment.slice(colonIdx + 1).trim();
      if (key) attributes[key] = value;
    }
  }
  return { label, attributes };
}

function parseEntityListSection(text: string): { title: string; entries: EntityListEntry[] } | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  let title = "";
  const entries: EntityListEntry[] = [];
  let firstEntityIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const entry = parseEntityLine(lines[i]!);
    if (entry) {
      if (firstEntityIndex < 0) firstEntityIndex = i;
      entries.push(entry);
    } else if (firstEntityIndex < 0 && !lines[i]!.startsWith("- ")) {
      title = lines[i]!.replace(/:$/, "").trim();
    }
  }
  if (entries.length === 0) return null;
  if (!title && firstEntityIndex > 0) title = lines[0]!.replace(/:$/, "").trim();
  if (!title) title = "Results";
  return { title, entries };
}

function formatCountAnswer(count: number, unit: string, qualifier?: string): string {
  const q = qualifier?.trim() ? ` ${qualifier}` : "";
  return `Count: ${count} ${unit}${q}`.trim();
}

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

export type ResponseMode = keyof typeof MODE_INSTRUCTIONS;

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
  rawLine: string;
}

interface PathScope {
  from?: string;
  to?: string;
}

interface FirewallAliasDefinition {
  name: string;
  values: string[];
  rawLine: string;
}

interface AliasContentSummary {
  name: string;
  entries: string[];
  type?: string;
  enabled?: string;
  iface?: string;
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

/** True when query asks for a count (e.g. "how many vms have uptime > 20 days"). Count answers use canonical count format, not entity-list. */
function isCountQuery(userQuery: string): boolean {
  return /\bhow\s+many\b/i.test(userQuery.trim());
}

/**
 * Canonical count packaging: for "how many X" queries, return a single-line count answer
 * so we never feed count responses into entity-list parsing (which would produce fake rows like "None | Uptime=0 days").
 */
function normalizeCountPackaging(responseText: string, context: FormatContext): string | null {
  if (!isCountQuery(context.userQuery) || !responseText?.trim()) return null;
  const trimmed = responseText.trim();
  // Already a single short line → keep as-is (canonical count shape)
  const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && lines[0]!.length < 120) return lines[0]!;
  // Extract numeric count: "None" / "no VMs" → 0; "N VMs" / "N nodes" / "Count: N" → N
  let count: number | null = null;
  if (/none\s+of\s+the|no\s+vms?|zero\s+vms?|0\s+vms?/i.test(trimmed)) count = 0;
  const countMatch = trimmed.match(/(?:count\s*:\s*)?(\d+)\s*(vms?|nodes?|containers?|lxcs?|rules?|aliases?)/i)
    ?? trimmed.match(/(\d+)\s+(?:vms?|nodes?|containers?|lxcs?|rules?|aliases?)\s+(?:have|with)/i);
  if (countMatch) count = parseInt(countMatch[1]!, 10);
  if (count === null && lines.length > 0) {
    const first = lines[0]!;
    const numInFirst = first.match(/\b(\d+)\s+(?:vms?|nodes?|containers?)/i);
    if (numInFirst) count = parseInt(numInFirst[1]!, 10);
  }
  const unit = /\b(vms?|nodes?|containers?|lxcs?)\b/i.test(context.userQuery)
    ? (context.userQuery.match(/\b(vms?|nodes?|containers?|lxcs?)\b/i)?.[1] ?? "VMs")
    : "items";
  if (count !== null && !Number.isNaN(count)) {
    const qualifier = lines[0]?.replace(/^\D*\d+\s*(vms?|nodes?|containers?|lxcs?)\s*/i, "").replace(/\.$/, "").trim();
    return formatCountAnswer(count, unit, qualifier && qualifier.length < 80 ? qualifier : undefined);
  }
  // Couldn't confidently extract a single count. The response may be a
  // multi-line, data-bearing answer in a shape this function doesn't recognize
  // (e.g. a chain's "Firewall Rule Count\n- total | Count=104" line, or a
  // per-item breakdown for "how many X does each Y have"). Collapsing that to
  // just `lines[0]` silently throws the real answer away, so leave the
  // response untouched instead and let later packaging/formatting handle it.
  return null;
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
  if (!responseText) return null;
  // Count queries are handled by normalizeCountPackaging; skip entity-list as a safeguard
  if (isCountQuery(context.userQuery)) return null;
  const useEntityList =
    intent === "status" || intent === "compute_status" || intent === "compute_list" ||
    isStatusListQuery(context.userQuery);
  if (!useEntityList) return null;

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
      rawLine: line,
    });
  }
  return entries;
}

// A bare two-word phrase like "pass the salt" or "block him" parses as a
// technically-valid ParsedPfRule (action-only, per parseFilterRule's own
// contract for other callers) but isn't a real firewall rule. Only treat a
// parse as a genuine pf rule here if it carries at least one other field a
// real rule would have.
function isConfidentPfRule(rule: ReturnType<typeof parseFilterRule>): rule is NonNullable<typeof rule> {
  if (!rule) return false;
  return Boolean(rule.direction || rule.iface || rule.source || rule.destination || rule.port || rule.protocol);
}

function formatParsedPfRule(rule: ReturnType<typeof parseFilterRule>): string | null {
  if (!isConfidentPfRule(rule)) return null;
  const parts = [
    rule.action.toUpperCase(),
    rule.direction ? `dir=${rule.direction}` : null,
    rule.iface ? `if=${rule.ifaceNegated ? "!" : ""}${rule.iface}` : null,
    rule.protocol ? `proto=${rule.protocol}` : null,
    rule.source ? `src=${rule.source}` : null,
    rule.destination ? `dst=${rule.destination}` : null,
    rule.port ? `port=${rule.port}` : null,
  ].filter(Boolean);
  return parts.join(" | ");
}

/**
 * Rewrites raw pfctl rule syntax embedded in an otherwise free-form response
 * into the same readable `ACTION | dir=... | src=... | dst=...` pipe format
 * the rest of this module already produces for twin-sourced firewall data.
 *
 * The EXECUTE-path LLM loop sometimes echoes opnsense_readonly's live
 * `firewall_rules_list` output (an array of raw pfctl lines, e.g.
 * `"block drop in log on ! vtnet1 inet from 192.168.68.0/22 to any"`) verbatim
 * into its final answer instead of summarizing it — see fuzz-campaign F-06.
 * Observed live re-verification shapes vary: sometimes each raw rule is its
 * own quoted, pipe-joined string; sometimes the model dumps the *entire*
 * pipe-joined rule array as one giant quoted blob (with pf rule "label"
 * values' embedded quotes left escaped, e.g. `label \"abc123\"`, un-unescaped
 * from whatever the tool JSON originally looked like). Both are handled by
 * finding the true quoted span first (honoring escaped characters so it
 * isn't truncated at the first escaped inner quote), then splitting on the
 * model's own " | " join convention and prettifying each pf-rule-shaped
 * segment independently. This only rewrites substrings that actually parse
 * as a pf pass/block rule with real rule fields (via the same parser the
 * twin-first firewall chain uses); anything else (prose, housekeeping
 * directives like `scrub in all fragment reassemble`, already-formatted pipe
 * rules, incidental English sentences containing the words "pass"/"block")
 * passes through untouched.
 */
export function prettifyRawPfctlText(text: string): string {
  if (!text) return text;

  // Case 1: raw rule(s) inside a double-quoted span — either one rule per
  // quoted string, or an entire pipe-joined rule array quoted as a single
  // string. `(?:\\.|[^"\\])*` matches standard JSON-string-body semantics so
  // an escaped inner quote (from a rule's `label \"...\"`) doesn't end the
  // span early.
  let result = text.replace(/"((?:\\.|[^"\\])*)"/g, (whole, inner: string) => {
    if (!/\b(?:pass|block)\b/i.test(inner)) return whole;
    let rewroteAny = false;
    const segments = inner.split(/\s*\|\s*/).map((segment) => {
      const pretty = formatParsedPfRule(parseFilterRule(segment));
      if (pretty) rewroteAny = true;
      return pretty ?? segment;
    });
    return rewroteAny ? segments.join(" | ") : whole;
  });

  // Case 2: a raw rule appears bare, one per line (optionally bulleted),
  // without quoting.
  result = result
    .split("\n")
    .map((line) => {
      const bulletMatch = line.match(/^(\s*(?:[-*]\s+)?)((?:pass|block)\b.*)$/i);
      if (!bulletMatch) return line;
      const [, prefix, candidate] = bulletMatch;
      const pretty = formatParsedPfRule(parseFilterRule(candidate ?? ""));
      return pretty ? `${prefix}${pretty}` : line;
    })
    .join("\n");

  return result;
}

function stripAliasWrapper(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/^`|`$/g, "");
  const wrapped = trimmed.match(/^<([^>]+)>$/);
  return (wrapped?.[1] ?? trimmed).trim();
}

function parseFirewallAliasDefinitions(lines: string[]): FirewallAliasDefinition[] {
  const aliases: FirewallAliasDefinition[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.includes("| dir=") || line.includes("| src=") || line.includes("| dst=")) {
      continue;
    }

    const definitionMatch = line.match(/^Definition\s*\|\s*term=([^|]+)\|\s*meaning=([^|]+)(?:\||$)/i);
    if (definitionMatch?.[1]) {
      const name = definitionMatch[1].trim();
      const values = (definitionMatch[2] ?? "")
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      aliases.push({ name, values, rawLine: line });
      continue;
    }

    const kvMatch = line.match(/^-?\s*([a-z0-9_:-]+)\s*=\s*(.+)$/i);
    if (!kvMatch?.[1]) {
      continue;
    }
    const valueText = (kvMatch[2] ?? "").trim();
    const values = /^(?:\(empty\)|empty)$/i.test(valueText)
      ? []
      : valueText.split(",").map((value) => value.trim()).filter(Boolean);
    aliases.push({
      name: kvMatch[1].trim(),
      values,
      rawLine: line,
    });
  }
  return aliases;
}

function normalizePolicyTerm(value: string): string {
  return stripAliasWrapper(value)?.toUpperCase() ?? value.toUpperCase();
}

function extractFirewallPolicyTargets(userQuery: string, aliases: FirewallAliasDefinition[]): string[] {
  const query = userQuery.trim();
  if (!query) return [];

  const aliasValueTerms = new Set(
    aliases.flatMap((alias) => alias.values.map((value) => normalizePolicyTerm(value)))
  );
  const targets = new Set<string>();
  const commonTwoLetterWords = new Set([
    "AM", "AN", "AS", "AT", "BE", "BY", "DO", "GO", "IF", "IN", "IS", "IT", "ME", "MY",
    "NO", "OF", "ON", "OR", "SO", "TO", "UP", "WE",
  ]);

  for (const match of query.matchAll(/\b([A-Za-z]{2})\b/g)) {
    const token = match[1] ?? "";
    const normalized = token.toUpperCase();
    const wasUppercase = token === normalized;
    if (wasUppercase || aliasValueTerms.has(normalized) || !commonTwoLetterWords.has(normalized)) {
      targets.add(normalized);
    }
  }

  for (const alias of aliases) {
    const aliasName = alias.name.toLowerCase();
    if (new RegExp(`\\b${aliasName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(query)) {
      targets.add(normalizePolicyTerm(alias.name));
    }
  }

  return Array.from(targets);
}

function detectFirewallPolicyAction(userQuery: string): "block" | "allow" | null {
  const query = userQuery.toLowerCase();
  if (/\b(block|blocking|blocked|deny|denying|denied|reject|rejecting|rejected)\b/.test(query)) {
    return "block";
  }
  if (/\b(allow|allowing|allowed|permit|permitting|permitted|pass|passing|open)\b/.test(query)) {
    return "allow";
  }
  return null;
}

function isFirewallPolicyQuestion(userQuery: string): boolean {
  const query = userQuery.toLowerCase();
  const asksYesNo =
    /^(?:is|are|does|do)\b/.test(query.trim()) ||
    /\b(?:is|are)\s+there\b/.test(query) ||
    /\bany\b.*\b(firewall|rules?|policy)\b/.test(query) ||
    /\bwhether\b/.test(query);
  return asksYesNo && /\b(firewall|rules?|policy|blocked|allowed|blocking|allowing)\b/.test(query);
}

function formatTargetList(targets: string[]): string {
  if (targets.length === 0) return "the requested scope";
  if (targets.length === 1) return targets[0]!;
  if (targets.length === 2) return `${targets[0]} and ${targets[1]}`;
  return `${targets.slice(0, -1).join(", ")}, and ${targets[targets.length - 1]}`;
}

function ruleMatchesPolicyAction(rule: FirewallRuleEntry, action: "block" | "allow"): boolean {
  const blockActions = new Set(["BLOCK", "DENY", "REJECT"]);
  const allowActions = new Set(["ALLOW", "PASS"]);
  return action === "block" ? blockActions.has(rule.action) : allowActions.has(rule.action);
}

function matchRulePolicyTargets(
  rule: FirewallRuleEntry,
  targets: string[],
  aliases: FirewallAliasDefinition[]
): { matchedTargets: string[]; matchedAliases: FirewallAliasDefinition[] } {
  const endpointNames = [rule.source, rule.destination].map(stripAliasWrapper).filter(Boolean) as string[];
  const endpointTerms = new Set(endpointNames.map((value) => normalizePolicyTerm(value)));
  const aliasesByName = new Map(aliases.map((alias) => [alias.name.toLowerCase(), alias]));
  const endpointAliases = endpointNames
    .map((name) => aliasesByName.get(name.toLowerCase()))
    .filter(Boolean) as FirewallAliasDefinition[];
  const expandedTerms = new Set([
    ...Array.from(endpointTerms),
    ...endpointAliases.flatMap((alias) => alias.values.map((value) => normalizePolicyTerm(value))),
  ]);

  const normalizedTargets = targets.map(normalizePolicyTerm);
  const matchedTargets = normalizedTargets.length === 0
    ? []
    : normalizedTargets.filter((target) => expandedTerms.has(target));
  const matchedAliases = endpointAliases.filter((alias) => {
    const aliasName = normalizePolicyTerm(alias.name);
    return matchedTargets.length > 0 || normalizedTargets.includes(aliasName);
  });

  return { matchedTargets, matchedAliases };
}

function formatFirewallPolicyQuestionAnswer(
  rules: FirewallRuleEntry[],
  aliases: FirewallAliasDefinition[],
  context: FormatContext
): string | null {
  if (rules.length === 0 || !isFirewallPolicyQuestion(context.userQuery)) {
    return null;
  }
  const action = detectFirewallPolicyAction(context.userQuery);
  if (!action) {
    return null;
  }

  const targets = extractFirewallPolicyTargets(context.userQuery, aliases);
  const actionRules = rules.filter((rule) => ruleMatchesPolicyAction(rule, action));
  const matches = actionRules
    .map((rule) => ({ rule, ...matchRulePolicyTargets(rule, targets, aliases) }))
    .filter((match) => targets.length === 0 || match.matchedTargets.length > 0 || match.matchedAliases.length > 0);
  const targetText = formatTargetList(targets);

  if (matches.length === 0) {
    const lines = [
      `Answer: No. No matching firewall rule was found for ${targetText} in the current firewall data.`,
      "",
      "Evidence:",
      `- Checked ${rules.length} firewall rule(s).`,
    ];
    if (aliases.length > 0) {
      lines.push(`- Alias definitions checked: ${aliases.map((alias) => alias.name).slice(0, 6).join(", ")}.`);
    }
    return lines.join("\n");
  }

  const bestMatch = matches[0]!;
  const matchedTargets = bestMatch.matchedTargets.length > 0 ? bestMatch.matchedTargets : targets;
  const matchedTargetText = formatTargetList(matchedTargets);
  const primaryAlias = bestMatch.matchedAliases[0];
  const direction = (bestMatch.rule.direction ?? "").toLowerCase() === "in" ? "Inbound " : "";
  const actionVerb = action === "block" ? "blocked" : "allowed";
  const aliasPhrase = primaryAlias ? ` by the \`${primaryAlias.name}\` alias` : "";
  const lines = [
    `Answer: Yes. ${direction}traffic from ${matchedTargetText} is ${actionVerb}${aliasPhrase}.`,
    "",
    "Evidence:",
    `- Rule: ${bestMatch.rule.rawLine}`,
  ];
  if (primaryAlias) {
    lines.push(`- Alias: ${primaryAlias.rawLine}`);
  }
  lines.push("", "Details:", "```text");
  for (const match of matches.slice(0, 5)) {
    lines.push(match.rule.rawLine);
  }
  lines.push("```");
  return lines.join("\n");
}

function cleanAliasContentEntry(value: string): string {
  return value
    .trim()
    .replace(/\s+\(selected\)$/i, "")
    .trim();
}

function parseAliasContentSummary(lines: string[]): AliasContentSummary | null {
  let name = "";
  const titleLine = lines.find((line) => /^Alias\s+".+"\s+Contents\b/i.test(line));
  const titleMatch = titleLine?.match(/^Alias\s+"(.+)"\s+Contents\b/i);
  if (titleMatch?.[1]) {
    name = titleMatch[1].trim();
  }

  let contentIndex = -1;
  const entries: string[] = [];
  const metadata: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const aliasNameMatch = line.match(/^Alias Name:\s*(.+)$/i);
    if (aliasNameMatch?.[1]) {
      name = aliasNameMatch[1].trim();
      continue;
    }
    const inlineContentMatch = line.match(/^Content:\s*(.+)$/i);
    if (inlineContentMatch?.[1]) {
      const cleaned = cleanAliasContentEntry(inlineContentMatch[1]);
      if (cleaned) entries.push(cleaned);
      contentIndex = i;
      continue;
    }
    if (/^Content:\s*$/i.test(line)) {
      contentIndex = i;
      continue;
    }
    const metadataMatch = line.match(/^(Type|Enabled|Interface):\s*(.+)$/i);
    if (metadataMatch?.[1]) {
      metadata[metadataMatch[1].toLowerCase()] = (metadataMatch[2] ?? "").trim();
    }
  }

  if (contentIndex >= 0) {
    for (const line of lines.slice(contentIndex + 1)) {
      if (/^(Type|Enabled|Interface|Additional Details|GeoIP URL):/i.test(line)) {
        break;
      }
      const cleaned = cleanAliasContentEntry(line);
      if (cleaned) entries.push(cleaned);
    }
  }

  if (!name || (contentIndex < 0 && entries.length === 0)) {
    return null;
  }
  return {
    name,
    entries,
    type: metadata.type,
    enabled: metadata.enabled,
    iface: metadata.interface,
  };
}

function formatAliasContentAnswer(responseText: string, context: FormatContext): string | null {
  const query = context.userQuery.toLowerCase();
  if (!/\balias\b/.test(query) && !/^Alias\s+".+"\s+Contents\b/im.test(responseText)) {
    return null;
  }

  const lines = responseText.split("\n").map((line) => line.trim()).filter(Boolean);
  const summary = parseAliasContentSummary(lines);
  if (!summary) {
    return null;
  }

  const entryText = summary.entries.length === 0
    ? "no entries"
    : summary.entries.length === 1
      ? `one entry: \`${summary.entries[0]}\``
      : `${summary.entries.length} entries: ${summary.entries.map((entry) => `\`${entry}\``).join(", ")}`;
  const linesOut = [
    `Answer: Alias \`${summary.name}\` contains ${entryText}.`,
  ];

  const evidence: string[] = [];
  if (summary.type) evidence.push(`- Type: ${summary.type}`);
  if (summary.enabled) evidence.push(`- Enabled: ${summary.enabled}`);
  if (summary.iface) evidence.push(`- Interface: ${summary.iface}`);
  if (evidence.length > 0) {
    linesOut.push("", "Evidence:", ...evidence);
  }

  return linesOut.join("\n");
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

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let escaped = false;

  for (const char of trimmed) {
    if (escaped) {
      cell += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
      cell += char;
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function normalizeWideSingleRecordTable(responseText: string): string | null {
  const lines = responseText.split("\n");
  for (let index = 0; index < lines.length - 2; index++) {
    const headerLine = lines[index];
    const separatorLine = lines[index + 1];
    const valueLine = lines[index + 2];
    if (headerLine === undefined || separatorLine === undefined || valueLine === undefined) {
      continue;
    }
    const headers = splitMarkdownTableRow(headerLine);
    const separators = splitMarkdownTableRow(separatorLine);
    if (
      headers.length < 8 ||
      headers.length !== separators.length ||
      !separators.every((cell) => /^:?-{3,}:?$/.test(cell))
    ) {
      continue;
    }

    const values = splitMarkdownTableRow(valueLine);
    if (values.length !== headers.length) continue;

    const nextLine = lines[index + 3]?.trim();
    if (nextLine?.includes("|")) continue;

    const nameIndex = headers.findIndex((header) => /^name$/i.test(header));
    const title = nameIndex >= 0 && values[nameIndex]
      ? `${values[nameIndex]} details`
      : "Entity details";
    const facts = headers
      .map((header, cellIndex) => {
        const label = header
          .replace(/_/g, " ")
          .replace(/\b\w/g, (char) => char.toUpperCase());
        return `- ${label}: ${values[cellIndex] || "Not available"}`;
      })
      .join("\n");

    const before = lines.slice(0, index).filter((line) => line.trim()).join("\n");
    const after = lines.slice(index + 3).filter((line) => line.trim()).join("\n");
    return [before, title, facts, after].filter(Boolean).join("\n");
  }

  return null;
}

export function applyAdaptivePackaging(
  responseText: string,
  context: FormatContext
): string | null {
  if (!responseText) return null;

  const wideRecordPackaging = normalizeWideSingleRecordTable(responseText);
  if (wideRecordPackaging) {
    return wideRecordPackaging;
  }

  // Count queries: canonical one-line count format only (never entity-list)
  const countPackaging = normalizeCountPackaging(responseText, context);
  if (countPackaging) {
    return countPackaging;
  }

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
    /\blist\b.*\b(all|every)\b.*\b(ports?|rules?)\b/i.test(normalizedQuery);
  if (wantsFullList) {
    return null;
  }

  const aliasContentAnswer = formatAliasContentAnswer(responseText, context);
  if (aliasContentAnswer) {
    return aliasContentAnswer;
  }

  const lines = responseText.split("\n").map((line) => line.trim()).filter(Boolean);
  const firewallRules = parseFirewallRuleEntries(lines);
  const hasFirewallRulesHeading = lines.some((line) => /^firewall rules\b/i.test(line));
  const canPackageFirewallPolicy =
    context.intentType === "firewall_rules" || hasFirewallRulesHeading || firewallRules.length > 0;
  if (canPackageFirewallPolicy) {
    const aliases = parseFirewallAliasDefinitions(lines);
    const firewallPolicyAnswer = formatFirewallPolicyQuestionAnswer(firewallRules, aliases, context);
    if (firewallPolicyAnswer) {
      return firewallPolicyAnswer;
    }
  }

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

    const systemPrompt = MODE_INSTRUCTIONS[context.mode];

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
      model: process.env.AGENT_CHAT_MODEL || "gpt-4o",
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
