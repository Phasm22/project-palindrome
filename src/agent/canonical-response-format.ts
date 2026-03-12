// TODO: remove once response-formatter no longer imports this
/**
 * Canonical response formats shared by formatter and dashboard.
 *
 * 1. Entity list (status/uptime/VM lists):
 *    - First line: section title (no leading "- ")
 *    - Following lines: "- label | key1=value1 | key2=value2" (one entity per line)
 *    Example: VM Uptime on proxBig / - windowsVM | VMID=100 | Uptime=32 days
 *    Dashboard: parse "- X | k=v | ..." under a section title → kv-cards.
 *
 * 2. Count answers ("how many X have Y?"):
 *    - One line only: "Count: N" or "N <unit> <qualifier>" (e.g. "0 VMs have uptime > 20 days").
 *    Formatter must not turn count answers into entity-list rows.
 */

export const CANONICAL_ENTITY_LIST_SPEC =
  "Section title on first line, then one line per entity: - name | key1=value1 | key2=value2";

export interface EntityListEntry {
  label: string;
  attributes: Record<string, string>;
}

export interface ParsedEntityList {
  title: string;
  entries: EntityListEntry[];
}

/**
 * Build one canonical entity line: "- label | k1=v1 | k2=v2"
 */
export function buildEntityLine(label: string, attributes: Record<string, string>): string {
  const pairs = Object.entries(attributes)
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => `${k}=${String(v).trim()}`);
  if (pairs.length === 0) return `- ${label}`;
  return `- ${label} | ${pairs.join(" | ")}`;
}

/**
 * Build a full canonical entity-list section (title + entity lines).
 */
export function buildEntityListSection(title: string, entries: EntityListEntry[]): string {
  const lines = [title.trim().replace(/:$/, "")];
  for (const e of entries) {
    lines.push(buildEntityLine(e.label, e.attributes));
  }
  return lines.join("\n");
}

/**
 * Parse a line into label and key=value attributes. Returns null if not in canonical shape.
 * Accepts both "key=value" and "key: value" for robustness.
 */
export function parseEntityLine(line: string): EntityListEntry | null {
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

/**
 * Parse text into a canonical entity-list section if it matches.
 * Expects: optional first line as title, then lines "- X | k=v | ...".
 * Returns null if fewer than one entity line or no title.
 */
export function parseEntityListSection(text: string): ParsedEntityList | null {
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

/**
 * Build a canonical one-line count answer for "how many X" queries.
 * Use this so count answers are consistent and never parsed as entity lists.
 */
export function formatCountAnswer(count: number, unit: string, qualifier?: string): string {
  const q = qualifier?.trim() ? ` ${qualifier}` : "";
  return `Count: ${count} ${unit}${q}`.trim();
}
