import { API_URL } from './utils.js';

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
      <div style="margin-bottom: 20px;">
        <h3 style="color: #60a5fa; margin-bottom: 15px;">Query Analysis</h3>
        <div class="status-grid">
          <div class="stat-card">
            <div class="stat-label">Query Type</div>
            <div class="stat-value">${data.queryType || 'Unknown'}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Total Score</div>
            <div class="stat-value">${(data.sTotalScore || 0).toFixed(3)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Sources Found</div>
            <div class="stat-value">${data.sources?.length || 0}</div>
          </div>
        </div>
      </div>
      
      ${(data.sources || []).length > 0 ? `
        <div style="margin-bottom: 20px;">
          <h3 style="color: #60a5fa; margin-bottom: 15px;">Top Sources (by relevance score)</h3>
          <div style="max-height: 400px; overflow-y: auto;">
            <table>
              <thead>
                <tr>
                  <th style="width: 30%;">Source</th>
                  <th style="width: 15%;">Score</th>
                  <th style="width: 55%;">Preview</th>
                </tr>
              </thead>
              <tbody>
                ${(data.sources || []).slice(0, 20).map(s => `
                  <tr>
                    <td style="font-family: monospace; font-size: 0.85em;">${s.sourcePath || s.chunkId || 'Unknown'}</td>
                    <td style="text-align: center;">
                      <span style="background: ${(s.score || 0) > 0.7 ? '#10b981' : (s.score || 0) > 0.4 ? '#f59e0b' : '#ef4444'}; color: white; padding: 2px 6px; border-radius: 3px; font-size: 0.85em; font-weight: 600;">
                        ${(s.score || 0).toFixed(3)}
                      </span>
                    </td>
                    <td style="color: #cbd5e1; font-size: 0.9em; max-width: 0; overflow: hidden; text-overflow: ellipsis;" title="${(s.textPreview || '').replace(/"/g, '&quot;')}">${(s.textPreview || '').substring(0, 150)}${(s.textPreview || '').length > 150 ? '...' : ''}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      ` : '<div style="color: #94a3b8; padding: 20px; text-align: center;">No sources found for this query.</div>'}
      
      <details style="margin-top: 20px;">
        <summary style="cursor: pointer; color: #94a3b8; font-size: 0.9em; padding: 10px; background: #0f172a; border: 1px solid #334155; border-radius: 4px;">
          Show Full Response (JSON)
        </summary>
        <pre style="margin-top: 10px; padding: 15px; background: #0f172a; border: 1px solid #334155; border-radius: 4px; overflow-x: auto; font-size: 0.8em; max-height: 400px; overflow-y: auto;">${JSON.stringify(data, null, 2)}</pre>
      </details>
    `;
    
    document.getElementById('rag-results').innerHTML = html;
  } catch (error) {
    document.getElementById('rag-results').innerHTML = 
      `<div class="error">Failed to test query: ${error.message}</div>`;
  }
}

// Make globally accessible for onclick handlers
window.testRagQuery = testRagQuery;

