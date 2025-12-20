// Shared utilities
// Use current hostname for API (supports remote access)
// HTTPS dashboard (8443) -> HTTPS API (4443), HTTP dashboard (8080) -> HTTP API (4000)
const apiPort = window.location.protocol === 'https:' ? 4443 : 4000;
export const API_URL = `${window.location.protocol}//${window.location.hostname}:${apiPort}`;

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Render responsive table: cards on mobile, table on desktop
export function renderResponsiveTable(headers, rows, rowRenderer) {
  // Extract cell content from HTML string - wrap in table for proper parsing
  const extractCellContent = (html) => {
    const temp = document.createElement('div');
    // Wrap in table structure so browsers parse td elements correctly
    temp.innerHTML = `<table><tbody><tr>${html}</tr></tbody></table>`;
    const cells = Array.from(temp.querySelectorAll('td'));
    return cells.map(cell => cell.innerHTML.trim());
  };
  
  const tableRows = rows.map((row, idx) => rowRenderer(row, idx));
  const cardRows = rows.map((row, idx) => {
    const rowHtml = rowRenderer(row, idx);
    const cells = extractCellContent(rowHtml);
    
    // Debug: log if cells are empty
    if (cells.length === 0) {
      console.warn('renderResponsiveTable: No cells extracted from row', rowHtml);
    }
    
    return `
      <div class="mobile-card">
        ${headers.map((header, i) => `
          <div class="mobile-card-row">
            <div class="mobile-card-label">${header}</div>
            <div class="mobile-card-value">${cells[i] || '<span style="color:#64748b;">N/A</span>'}</div>
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

