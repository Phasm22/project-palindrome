const SECTION_TYPES = new Set([
  "text",
  "status",
  "facts",
  "table",
  "collection",
  "steps",
  "alert",
  "details",
]);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function renderInlineText(value) {
  const source = String(value ?? "");
  const parts = source.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return parts.map((part) => {
    if (part.length >= 3 && part.startsWith("`") && part.endsWith("`")) {
      return `<code class="response-inline-code">${escapeHtml(part.slice(1, -1))}</code>`;
    }
    if (part.length >= 5 && part.startsWith("**") && part.endsWith("**")) {
      return `<strong>${escapeHtml(part.slice(2, -2))}</strong>`;
    }
    return escapeHtml(part);
  }).join("");
}

// --- Plain-text formatting fallback -----------------------------------
// The main LLM pass (and the raw-text fallback path when structuring fails)
// often emits pipe-delimited "entity | key=value | ..." rows, markdown-ish
// bullet/numbered lists, or plain prose. Browsers don't format any of that
// for free, so we parse it into real HTML (tables/lists) where the shape is
// unambiguous, and degrade to an aligned monospace ASCII table — never raw
// unformatted pipes — when it isn't.

function splitPipeCells(line) {
  // A leading "- "/"* " is a list-bullet marker, not part of the first
  // cell's content — TERSE_DATA emits single entities as bulleted pipe
  // rows ("- name | key=value | ...").
  let trimmed = line.trim().replace(/^[-*]\s+/, "");
  // Only strip a *paired* leading+trailing pipe ("| a | b |" markdown
  // fencing). A lone trailing pipe ("stopped |") means an empty last
  // cell, not decorative fencing — stripping it unconditionally used to
  // collapse the row to 1 cell, drop it from the table, and leak a
  // stray " | " into plain paragraph text.
  if (trimmed.length > 1 && trimmed.startsWith("|") && trimmed.endsWith("|")) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

function isBulletLine(line) {
  return /^[-*]\s+/.test(line.trim());
}

function isNumberedLine(line) {
  return /^\d+[.)]\s+/.test(line.trim());
}

function groupTextLines(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fenceMatch = line.match(/^```(\S*)\s*$/);
    if (fenceMatch) {
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      blocks.push({ type: "code", code: codeLines.join("\n") });
      continue;
    }

    if (line.includes("|")) {
      // Any line containing a literal pipe is routed here — never left as
      // plain-paragraph text — because a paragraph renders the raw line
      // verbatim and would leak the pipe character straight through. This
      // also covers a paired fence around a single value ("| YANG |"),
      // which collapses to 1 cell in splitPipeCells and would otherwise
      // fail a ">=2 cells" gate and fall through to a leaking paragraph.
      const rows = [];
      const firstCells = splitPipeCells(line);
      if (!isSeparatorRow(firstCells)) rows.push(firstCells);
      i++; // always advance — this line is consumed regardless of cell count
      while (i < lines.length && lines[i].trim()) {
        const cells = splitPipeCells(lines[i]);
        if (cells.length < 2) break;
        if (!isSeparatorRow(cells)) rows.push(cells);
        i++;
      }
      blocks.push({ type: "pipe", rows });
      continue;
    }

    if (isBulletLine(line)) {
      // Stop as soon as a bullet line contains a pipe — e.g. a plain
      // "- Exposed VMs:" header bullet followed by "- Name: X | Id: Y"
      // data bullets — so the pipe-bearing lines fall through to the
      // pipe-block branch above (on the next outer-loop iteration)
      // instead of being swallowed here as literal <li> text.
      const items = [];
      while (i < lines.length && isBulletLine(lines[i]) && !lines[i].includes("|")) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ type: "bullets", items });
      continue;
    }

    if (isNumberedLine(line)) {
      const items = [];
      while (i < lines.length && isNumberedLine(lines[i])) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push({ type: "numbered", items });
      continue;
    }

    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].includes("|") &&
      !isBulletLine(lines[i]) &&
      !isNumberedLine(lines[i]) &&
      !/^```/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", text: paraLines.join("\n") });
  }
  return blocks;
}

function renderAsciiTable(rows) {
  // Plain ASCII (+/-/|) rather than Unicode box-drawing: it's what "ASCII
  // art" actually means, and unlike box-drawing glyphs it renders
  // identically on every font/platform instead of going invisible when a
  // monospace fallback lacks full glyph coverage.
  const colCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: colCount }, (_, col) =>
    Math.max(3, ...rows.map((row) => (row[col] ?? "").length))
  );
  const hr = () => "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const rowLine = (cells) =>
    "| " + widths.map((w, idx) => (cells[idx] ?? "").padEnd(w, " ")).join(" | ") + " |";

  const lines = [hr()];
  rows.forEach((row, idx) => {
    lines.push(rowLine(row));
    if (idx === 0 && rows.length > 1) lines.push(hr());
  });
  lines.push(hr());
  return `<pre class="response-ascii-table">${escapeHtml(lines.join("\n"))}</pre>`;
}

// Bounds the "key" side of a key=value cell match. DNS domain names —
// including long mDNS reverse-PTR names like
// "lb._dns-sd._udp.0.68.168.192.in-addr.arpa" (41 chars) — legitimately
// exceed a short cap when they end up standing in as the "key" text (e.g.
// TERSE_DATA emitting "domain=count" pairs). 100 comfortably covers real
// DNS names (max 253, individual labels max 63) while each match is still
// bounded to one already-pipe-split cell, not free-running prose.
const KEY_VALUE_RE = /^([^:=]{1,100})[:=]\s*(.+)$/;

// Matches TERSE_DATA's documented convention for describing one or more
// named things: "entity | key=value | key=value ...", with no header row.
// The first cell is a bare label (not itself key=value); every cell after
// it is. This is distinct from a facts line where *every* cell is k=v.
function parseEntityRow(cells) {
  if (cells.length < 2) return null;
  const fields = [];
  for (const cell of cells.slice(1)) {
    const match = cell.match(KEY_VALUE_RE);
    if (!match) return null;
    fields.push([match[1].trim(), match[2].trim()]);
  }
  return { entity: cells[0], fields };
}

// Entity rows tolerate a different field count per row by design (a VM with
// only "status" and a VM with "status/node/uptime" are still the same kind
// of thing) — so this checks whether rows share a common vocabulary, not
// identical arity. Two rows sharing zero keys (e.g. a "top_domains" facts
// blob next to an unrelated "dns_blocking_enabled" facts blob, both TERSE_DATA
// pipe rows but describing different things) aren't the same table.
function hasSharedSchema(entityRows) {
  if (entityRows.length < 2) return true;
  const keyCounts = new Map();
  for (const row of entityRows) {
    for (const key of new Set(row.fields.map(([k]) => k))) {
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(entityRows.length / 2));
  for (const count of keyCounts.values()) {
    if (count >= threshold) return true;
  }
  return false;
}

// A repeated key within one row ("top_domains | domain=a.com | count=10 |
// domain=b.com | count=20") means the row is really a flattened list of
// tuples, not a set of distinct attributes — folding it into
// { [key]: value } in the union-table builder below would silently
// overwrite every earlier occurrence and drop data. Route these to
// renderFactGroups instead, which keeps every field entry.
function hasDuplicateKeys(fields) {
  const seen = new Set();
  for (const [key] of fields) {
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

// TERSE_DATA sometimes stamps a repeated type label into every row
// ("| Entity | VM Name=opnsense | Node=proxBig | ...") instead of using the
// real name as the first cell. When every data row shares a generic label and
// a name-like field, promote that field so the CSS table isn't a wall of
// identical "Entity" cells.
const GENERIC_ENTITY_LABELS = new Set(["entity", "item", "row", "record", "entry"]);
const ENTITY_NAME_KEYS = ["VM Name", "Name", "name", "vm_name", "hostname", "Hostname", "Host"];

function promoteGenericEntityLabels(entityRows) {
  const dataRows = entityRows.filter((row) => !/^total$/i.test(row.entity.trim()));
  if (dataRows.length < 1) return entityRows;

  const labels = new Set(dataRows.map((row) => row.entity.trim().toLowerCase()));
  if (labels.size !== 1) return entityRows;
  const [onlyLabel] = labels;
  if (!GENERIC_ENTITY_LABELS.has(onlyLabel)) return entityRows;

  let nameKey = null;
  for (const key of ENTITY_NAME_KEYS) {
    if (dataRows.every((row) => row.fields.some(([fieldKey]) => fieldKey === key))) {
      nameKey = key;
      break;
    }
  }
  if (!nameKey) return entityRows;

  return entityRows.map((row) => {
    if (/^total$/i.test(row.entity.trim())) return row;
    const nameField = row.fields.find(([fieldKey]) => fieldKey === nameKey);
    if (!nameField) return row;
    return {
      entity: nameField[1],
      fields: row.fields.filter(([fieldKey]) => fieldKey !== nameKey),
    };
  });
}

// Renders heterogeneous entity rows (no shared field vocabulary) as
// independent labeled fact panels instead of one table with mostly-empty
// cells — readable per-entity, not a sparse grid.
function renderFactGroups(entityRows) {
  return `<div class="response-fact-groups">${entityRows.map((row) => `
    <div class="response-fact-group">
      <div class="response-fact-group-title">${escapeHtml(row.entity)}</div>
      <dl class="response-facts">${row.fields.map(([key, value]) => `
        <div class="response-fact"><dt>${escapeHtml(key)}</dt><dd>${renderInlineText(value)}</dd></div>
      `).join("")}</dl>
    </div>
  `).join("")}</div>`;
}

function renderPipeBlock(rows) {
  if (!rows.length) return "";

  if (rows.length === 1) {
    const cells = rows[0];
    const asFacts = cells.map((cell) => cell.match(KEY_VALUE_RE));
    if (asFacts.every(Boolean)) {
      return `<dl class="response-facts">${asFacts.map((match) => `
        <div class="response-fact"><dt>${escapeHtml(match[1].trim())}</dt><dd>${renderInlineText(match[2].trim())}</dd></div>
      `).join("")}</dl>`;
    }
  }

  // Entity rows ("entity | key=value | ...") are tried before requiring
  // uniform cell counts across rows — see hasSharedSchema above for why
  // ragged arity alone isn't a reason to give up on a real table.
  const parsedEntityRows = rows.map(parseEntityRow);
  if (parsedEntityRows.every(Boolean)) {
    const entityRows = promoteGenericEntityLabels(parsedEntityRows);
    if (hasSharedSchema(entityRows) && !entityRows.some((row) => hasDuplicateKeys(row.fields))) {
      const keyOrder = [];
      entityRows.forEach((row) => row.fields.forEach(([key]) => {
        if (!keyOrder.includes(key)) keyOrder.push(key);
      }));
      const columns = [{ key: "entity", label: "Entity" }, ...keyOrder.map((key) => ({ key, label: key }))];
      const records = entityRows.map((row) => {
        const record = { entity: row.entity };
        row.fields.forEach(([key, value]) => { record[key] = value; });
        return record;
      });
      return renderTable(records, columns);
    }
    return renderFactGroups(entityRows);
  }

  const arity = rows[0].length;
  const consistent = rows.every((row) => row.length === arity);
  if (!consistent) {
    // Ragged pipe counts with no key=value structure to fall back on mean
    // we can't confidently infer columns — still guarantee a readable,
    // aligned table instead of a wall of raw pipes.
    return renderAsciiTable(rows);
  }

  if (rows.length >= 2) {
    const [header, ...body] = rows;
    const columns = header.map((label, idx) => ({ key: String(idx), label }));
    const records = body.map((row) => Object.fromEntries(row.map((cell, idx) => [String(idx), cell])));
    return renderTable(records, columns);
  }

  // Bare positional values with no header, no "key=value", and no shared
  // entity label ("piholelab | running | yin") — a vertical bullet list
  // reads as an unordered list of unrelated facts when these are really one
  // short, ordered tuple. Compact inline chips keep it scannable in one line.
  return `<div class="response-value-chips">${rows[0].map((cell) => `<span class="response-value-chip">${renderInlineText(cell)}</span>`).join("")}</div>`;
}

export function renderTextBlock(text) {
  const blocks = groupTextLines(text);
  if (!blocks.length) return "";
  return blocks.map((block) => {
    if (block.type === "code") {
      return `<pre class="response-code-block"><code>${escapeHtml(block.code)}</code></pre>`;
    }
    if (block.type === "pipe") return renderPipeBlock(block.rows);
    if (block.type === "bullets") {
      return `<ul class="response-list">${block.items.map((item) => `<li>${renderInlineText(item)}</li>`).join("")}</ul>`;
    }
    if (block.type === "numbered") {
      return `<ol class="response-list">${block.items.map((item) => `<li>${renderInlineText(item)}</li>`).join("")}</ol>`;
    }
    return `<p class="response-paragraph">${renderInlineText(block.text)}</p>`;
  }).join("");
}

function renderScalar(value) {
  if (value === null || value === undefined) {
    return '<span class="response-null">None</span>';
  }
  if (typeof value === "boolean") {
    return `<span class="response-boolean response-boolean-${value}">${value ? "Yes" : "No"}</span>`;
  }
  return `<span class="response-scalar">${renderInlineText(value)}</span>`;
}

function sharedRecordKeys(values) {
  if (!values.length || !values.every(isRecord)) return [];
  const keys = Object.keys(values[0]);
  return keys.length && values.every((value) => keys.every((key) => key in value)) ? keys : [];
}

// Splits "local: 93.93GB total (51.29GB used), local-lvm: 348.82GB total
// (47.19GB used)" into its two top-level items without also splitting the
// "2 QEMU, 3 LXC" inside "5 VMs (2 QEMU, 3 LXC)" — commas nested inside
// (), [], or {} don't count as separators.
function splitTopLevelCommas(text) {
  const segments = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function renderTableCellValue(value) {
  if (typeof value === "string") {
    const segments = splitTopLevelCommas(value);
    if (segments.length > 1) {
      return segments.map((segment) => `<div class="response-table-cell-line">${renderInlineText(segment)}</div>`).join("");
    }
  }
  return renderAdaptiveValue(value, { compact: true });
}

function renderTable(rows, columns) {
  if (!rows.length || !columns.length) return "";
  const headers = columns
    .map((column) => `<th>${escapeHtml(column.label)}</th>`)
    .join("");
  const body = rows.map((row) => {
    const cells = columns.map((column) =>
      `<td>${renderTableCellValue(row[column.key])}</td>`
    ).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `
    <div class="response-table-scroll">
      <table class="response-table">
        <thead><tr>${headers}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function normalizeExplicitTable(value) {
  if (!isRecord(value) || !Array.isArray(value.headers) || !Array.isArray(value.rows)) {
    return null;
  }
  const columns = value.headers.map((header, index) => ({
    key: String(index),
    label: String(header),
  }));
  const rows = value.rows
    .filter(Array.isArray)
    .map((row) => Object.fromEntries(row.map((cell, index) => [String(index), cell])));
  return { columns, rows };
}

function renderArray(values, options) {
  if (!values.length) return '<span class="response-empty">No items</span>';

  const keys = sharedRecordKeys(values);
  if (keys.length && values.length > 1) {
    return renderTable(values, keys.map((key) => ({ key, label: key })));
  }

  const tag = options.ordered ? "ol" : "ul";
  return `<${tag} class="response-list">${values
    .map((value) => `<li>${renderAdaptiveValue(value)}</li>`)
    .join("")}</${tag}>`;
}

function renderRecord(value, options) {
  const explicitTable = normalizeExplicitTable(value);
  if (explicitTable) return renderTable(explicitTable.rows, explicitTable.columns);

  const entries = Object.entries(value);
  if (!entries.length) return '<span class="response-empty">No data</span>';

  if (options.compact) {
    return `<span class="response-inline-record">${entries.map(([key, item]) =>
      `<span><strong>${escapeHtml(key)}:</strong> ${renderAdaptiveValue(item, { compact: true })}</span>`
    ).join("")}</span>`;
  }

  return `<dl class="response-facts">${entries.map(([key, item]) => `
    <div class="response-fact">
      <dt>${escapeHtml(key)}</dt>
      <dd>${renderAdaptiveValue(item)}</dd>
    </div>
  `).join("")}</dl>`;
}

function connectionStatusLabel(status) {
  if (status === "verified") return "Verified";
  if (status === "failed") return "Failed";
  return "Verifying…";
}

export function renderConnectionEndpoints(value) {
  const endpoints = Array.isArray(value) ? value : [];
  if (!endpoints.length) return '<span class="response-empty">No connection endpoints</span>';
  return `<div class="connection-grid">${endpoints.map((endpoint) => {
    const status = ["verified", "failed"].includes(endpoint?.status) ? endpoint.status : "pending";
    const copyValue = String(endpoint?.value ?? "");
    return `
      <div class="connection-card connection-card-${status}">
        <div class="connection-card-header">
          <strong>${escapeHtml(endpoint?.service || endpoint?.protocol || "Connection")}</strong>
          <span class="connection-status connection-status-${status}">${connectionStatusLabel(status)}</span>
        </div>
        <div class="connection-meta">${escapeHtml(String(endpoint?.addressType || "host").toUpperCase())} · ${escapeHtml(endpoint?.protocol || "")} · port ${escapeHtml(endpoint?.port || "")}</div>
        <div class="connection-value-row">
          <code>${escapeHtml(copyValue)}</code>
          <button type="button" data-copyable="${escapeHtml(copyValue)}" onclick="window.copyCopyableText(this)" ${copyValue ? "" : "disabled"}>Copy</button>
        </div>
        ${endpoint?.detail ? `<div class="connection-detail">${escapeHtml(endpoint.detail)}</div>` : ""}
      </div>`;
  }).join("")}</div>`;
}

export function renderAdaptiveValue(value, options = {}) {
  if (Array.isArray(value)) return renderArray(value, options);
  if (isRecord(value)) return renderRecord(value, options);
  return renderScalar(value);
}

function renderSection(section) {
  if (!isRecord(section)) return renderAdaptiveValue(section);

  const type = SECTION_TYPES.has(section.type) ? section.type : "details";
  const titleText = section.title ? String(section.title) : "";
  const title = titleText
    ? `<h4 class="response-section-title">${escapeHtml(section.title)}</h4>`
    : "";
  const content = type === "steps"
    ? renderAdaptiveValue(section.data, { ordered: true })
    : type === "connections"
      ? renderConnectionEndpoints(section.data)
    : (type === "text" || type === "alert") && typeof section.data === "string"
      ? renderTextBlock(section.data)
    : renderAdaptiveValue(section.data);

  if (type === "details") {
    return `<details class="response-details"><summary>${escapeHtml(titleText || "Details")}</summary>${content}</details>`;
  }

  return `<section class="response-section response-section-${type}">${title}${content}</section>`;
}

export function renderRawTextFallback(text) {
  const cleanText = String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
  return cleanText.trim()
    ? `<div class="response-raw-text">${renderTextBlock(cleanText)}</div>`
    : "";
}

export function renderAssistantResponse(message) {
  const structured = message?.structuredResponse;
  if (!structured || structured.version !== "2" || !isRecord(structured.answer)) {
    return renderRawTextFallback(message?.rawTextFallback ?? message?.text ?? message?.content ?? "");
  }

  const summary = structured.answer.summary
    ? `<p class="response-summary">${renderInlineText(structured.answer.summary)}</p>`
    : "";
  const sections = Array.isArray(structured.answer.sections)
    ? structured.answer.sections.map(renderSection).join("")
    : "";
  return `<div class="structured-response">${summary}${sections}</div>`;
}
