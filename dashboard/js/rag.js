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
      <h3>Query Results</h3>
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
      
      <h3 style="margin-top: 20px;">Top Sources</h3>
      <table>
        <tr>
          <th>Source</th>
          <th>Score</th>
          <th>Preview</th>
        </tr>
        ${(data.sources || []).slice(0, 10).map(s => `
          <tr>
            <td>${s.sourcePath || s.chunkId || 'Unknown'}</td>
            <td>${(s.score || 0).toFixed(3)}</td>
            <td>${s.textPreview || ''}</td>
          </tr>
        `).join('')}
      </table>
      
      <h3 style="margin-top: 20px;">Full Response</h3>
      <pre>${JSON.stringify(data, null, 2)}</pre>
    `;
    
    document.getElementById('rag-results').innerHTML = html;
  } catch (error) {
    document.getElementById('rag-results').innerHTML = 
      `<div class="error">Failed to test query: ${error.message}</div>`;
  }
}

// Make globally accessible for onclick handlers
window.testRagQuery = testRagQuery;

