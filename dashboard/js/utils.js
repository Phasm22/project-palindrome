// Shared utilities
export const API_URL = "http://localhost:4000";

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Render responsive table: cards on mobile, table on desktop
export function renderResponsiveTable(headers, rows, rowRenderer) {
  // Extract cell content from HTML string
  const extractCellContent = (html) => {
    const temp = document.createElement('div');
    temp.innerHTML = html;
    const cells = Array.from(temp.querySelectorAll('td'));
    return cells.map(cell => cell.innerHTML.trim());
  };
  
  const tableRows = rows.map((row, idx) => rowRenderer(row, idx));
  const cardRows = rows.map((row, idx) => {
    const rowHtml = rowRenderer(row, idx);
    const cells = extractCellContent(rowHtml);
    return `
      <div class="bg-slate-800 border border-slate-700 rounded-lg p-4 mb-3">
        ${headers.map((header, i) => `
          <div class="mb-2 ${i === headers.length - 1 ? 'mb-0' : ''}">
            <div class="text-xs text-slate-400 font-semibold mb-1">${header}</div>
            <div class="text-sm text-slate-200">${cells[i] || ''}</div>
          </div>
        `).join('')}
      </div>
    `;
  });
  
  const tableHtml = `
    <div class="table-responsive">
      <table class="w-full">
        <thead>
          <tr>
            ${headers.map(h => `<th class="text-left">${h}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${tableRows.map(row => `<tr>${row}</tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="card-responsive">
      ${cardRows.join('')}
    </div>
  `;
  return tableHtml;
}

