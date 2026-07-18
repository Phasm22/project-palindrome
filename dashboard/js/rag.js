import { API_URL, escapeHtml, renderResponsiveTable } from './utils.js';

export async function testRagQuery() {
  const query = document.getElementById('rag-query').value;
  if (!query) {
    alert('Please enter a query');
    return;
  }
  
  document.getElementById('rag-results').innerHTML = '<div class="loading">Testing query...</div>';
  
  try {
    const response = await fetch(`${API_URL}/api/dashboard/rag-diagnostics?query=${encodeURIComponent(query)}&aclGroup=admin`);
    const data = await response.json();
    
    const html = `
      <div class="results-section">
        <h3>Query Analysis</h3>
        <div class="metric-grid">
          <div class="metric-card">
            <div class="stat-label">Query Type</div>
            <div class="metric-value">${escapeHtml(data.queryType || 'Unknown')}</div>
          </div>
          <div class="metric-card">
            <div class="stat-label">Total Score</div>
            <div class="metric-value">${escapeHtml((data.sTotalScore || 0).toFixed(3))}</div>
          </div>
          <div class="metric-card">
            <div class="stat-label">Sources Found</div>
            <div class="metric-value">${escapeHtml(String(data.sources?.length || 0))}</div>
          </div>
        </div>
      </div>
      
      ${(data.sources || []).length > 0 ? `
        <div class="results-section">
          <h3>Top Sources</h3>
          ${renderResponsiveTable(
            ['Source', 'Score', 'Preview'],
            (data.sources || []).slice(0, 20),
            (s) => {
              const sourcePath = (s.sourcePath || s.chunkId || 'Unknown').split('\n')[0];
              const preview = (s.textPreview || '').split('\n')[0];
              const score = s.score || 0;
              const tone = score > 0.7 ? 'status-success' : score > 0.4 ? 'status-warning' : 'status-error';
              return `
                <td class="font-mono text-xs whitespace-nowrap">${escapeHtml(sourcePath)}</td>
                <td class="whitespace-nowrap"><span class="status-badge status-badge-dense ${tone}">${escapeHtml(score.toFixed(3))}</span></td>
                <td class="max-w-md truncate" title="${escapeHtml(preview)}">${escapeHtml(preview.substring(0, 150))}${preview.length > 150 ? '...' : ''}</td>
              `;
            }
          )}
        </div>
      ` : '<div class="empty-row">No sources found for this query.</div>'}
      
      <details class="dashboard-details">
        <summary>Full Response JSON</summary>
        <pre class="json-block">${escapeHtml(JSON.stringify(data, null, 2))}</pre>
      </details>
    `;
    
    document.getElementById('rag-results').innerHTML = html;
  } catch (error) {
    document.getElementById('rag-results').innerHTML = 
      `<div class="error">Failed to test query: ${escapeHtml(error.message)}</div>`;
  }
}

// Make globally accessible for onclick handlers
window.testRagQuery = testRagQuery;
