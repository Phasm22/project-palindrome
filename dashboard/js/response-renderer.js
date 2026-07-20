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
  const parts = source.split(/(`[^`\n]+`)/g);
  return parts.map((part) => {
    if (part.length >= 3 && part.startsWith("`") && part.endsWith("`")) {
      return `<code class="response-inline-code">${escapeHtml(part.slice(1, -1))}</code>`;
    }
    return escapeHtml(part);
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

function renderTable(rows, columns) {
  if (!rows.length || !columns.length) return "";
  const headers = columns
    .map((column) => `<th>${escapeHtml(column.label)}</th>`)
    .join("");
  const body = rows.map((row) => {
    const cells = columns.map((column) =>
      `<td>${renderAdaptiveValue(row[column.key], { compact: true })}</td>`
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
    : renderAdaptiveValue(section.data);

  if (type === "details") {
    return `<details class="response-details"><summary>${escapeHtml(titleText || "Details")}</summary>${content}</details>`;
  }

  return `<section class="response-section response-section-${type}">${title}${content}</section>`;
}

export function renderRawTextFallback(text) {
  const cleanText = String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");
  return cleanText
    ? `<div class="response-raw-text">${renderInlineText(cleanText)}</div>`
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
