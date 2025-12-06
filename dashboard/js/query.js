import { API_URL } from './utils.js';

export function setupQueryInterface() {
  const queryTypeSelect = document.getElementById('query-type');
  if (!queryTypeSelect) return;

  // Handle query type change
  queryTypeSelect.addEventListener('change', function() {
    const type = this.value;
    document.getElementById('rag-query-section').style.display = type === 'rag' ? 'block' : 'none';
    document.getElementById('graph-query-section').style.display = type === 'graph' ? 'block' : 'none';
    document.getElementById('cypher-query-section').style.display = type === 'cypher' ? 'block' : 'none';
  });

  // Handle graph query type change (for findPath second param)
  const graphQueryType = document.getElementById('graph-query-type');
  if (graphQueryType) {
    graphQueryType.addEventListener('change', function() {
      const param2Input = document.getElementById('graph-query-param2');
      if (param2Input) {
        param2Input.style.display = this.value === 'findPath' ? 'block' : 'none';
      }
    });
  }
}

// Execute RAG query
export async function executeQuery() {
  const query = document.getElementById('query-input').value;
  if (!query) {
    alert('Please enter a query');
    return;
  }

  const resultsDiv = document.getElementById('query-results');
  resultsDiv.innerHTML = '<div class="loading">Querying...</div>';

  try {
    const response = await fetch(`${API_URL}/api/dashboard/query/rag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, userId: 'dashboard-user', aclGroup: 'admin' })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    const data = result.data || result;

    let html = '<h3 style="color: #f97316; margin-bottom: 15px;">Answer</h3>';
    html += `<div style="color: #e2e8f0; margin-bottom: 20px; padding: 15px; background: #1e293b; border-radius: 4px;">${(data.answer || 'No answer provided').split('\n')[0]}</div>`;

    if (data.sources && data.sources.length > 0) {
      html += '<h3 style="color: #f97316; margin-bottom: 15px;">Sources</h3>';
      html += '<table><thead><tr><th>Source</th><th>Score</th><th>Preview</th></tr></thead><tbody>';
      data.sources.forEach(source => {
        const sourcePath = ((source.sourcePath || source.chunkId || 'Unknown').split('\n')[0]);
        const preview = ((source.text || '').split('\n')[0]).substring(0, 100);
        html += `<tr>
          <td class="whitespace-nowrap">${sourcePath}</td>
          <td class="whitespace-nowrap">${(source.score || 0).toFixed(4)}</td>
          <td class="max-w-md truncate" title="${preview.replace(/"/g, '&quot;')}">${preview}${preview.length >= 100 ? '...' : ''}</td>
        </tr>`;
      });
      html += '</tbody></table>';
    }

    if (data.sTotalScore !== null && data.sTotalScore !== undefined) {
      html += `<div style="margin-top: 15px; color: #94a3b8;">Total Score: ${data.sTotalScore.toFixed(4)}</div>`;
    }

    resultsDiv.innerHTML = html;
  } catch (error) {
    resultsDiv.innerHTML = `<div class="error">Failed to execute query: ${error.message}</div>`;
  }
}

// Execute graph query
export async function executeGraphQuery() {
  const queryType = document.getElementById('graph-query-type').value;
  const param = document.getElementById('graph-query-param').value;
  const param2 = document.getElementById('graph-query-param2').value;

  if (!param) {
    alert('Please enter a parameter');
    return;
  }

  const resultsDiv = document.getElementById('query-results');
  resultsDiv.innerHTML = '<div class="loading">Querying graph...</div>';

  try {
    const response = await fetch(`${API_URL}/api/dashboard/query/graph`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queryType, param, param2: param2 || undefined })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    const data = result.data || result;

    let html = '<h3 style="color: #f97316; margin-bottom: 15px;">Graph Query Results</h3>';
    html += `<div style="color: #94a3b8; margin-bottom: 15px;">Found ${data.nodes?.length || 0} nodes, ${data.relationships?.length || 0} relationships</div>`;

    if (data.nodes && data.nodes.length > 0) {
      html += '<h4 style="color: #94a3b8; margin-top: 20px;">Nodes</h4>';
      html += '<table><thead><tr><th>ID</th><th>Type</th><th>Attributes</th></tr></thead><tbody>';
      data.nodes.slice(0, 50).forEach(node => {
        const nodeId = ((node.id || 'N/A').toString().split('\n')[0]);
        const nodeType = ((node.type || 'N/A').toString().split('\n')[0]);
        html += `<tr>
          <td class="whitespace-nowrap">${nodeId}</td>
          <td class="whitespace-nowrap">${nodeType}</td>
          <td><pre style="max-width: 400px; overflow: auto; font-size: 0.85em;">${JSON.stringify(node.attributes || {}, null, 2)}</pre></td>
        </tr>`;
      });
      html += '</tbody></table>';
    }

    if (data.relationships && data.relationships.length > 0) {
      html += '<h4 style="color: #94a3b8; margin-top: 20px;">Relationships</h4>';
      html += '<table><thead><tr><th>From</th><th>Type</th><th>To</th></tr></thead><tbody>';
      data.relationships.slice(0, 50).forEach(rel => {
        html += `<tr>
          <td class="whitespace-nowrap">${((rel.from || 'N/A').toString().split('\n')[0])}</td>
          <td class="whitespace-nowrap">${((rel.type || 'N/A').toString().split('\n')[0])}</td>
          <td class="whitespace-nowrap">${((rel.to || 'N/A').toString().split('\n')[0])}</td>
        </tr>`;
      });
      html += '</tbody></table>';
    }

    resultsDiv.innerHTML = html;
  } catch (error) {
    resultsDiv.innerHTML = `<div class="error">Failed to execute graph query: ${error.message}</div>`;
  }
}

// Execute Cypher query
export async function executeCypherQuery() {
  const cypher = document.getElementById('cypher-input').value;
  if (!cypher) {
    alert('Please enter a Cypher query');
    return;
  }

  const resultsDiv = document.getElementById('query-results');
  resultsDiv.innerHTML = '<div class="loading">Executing Cypher query...</div>';

  try {
    const response = await fetch(`${API_URL}/api/dashboard/query/cypher`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cypher, limit: 100 })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();
    const data = result.data || result;

    let html = '<h3 style="color: #f97316; margin-bottom: 15px;">Cypher Query Results</h3>';
    html += `<div style="color: #94a3b8; margin-bottom: 15px;">Found ${data.nodes?.length || 0} nodes, ${data.relationships?.length || 0} relationships</div>`;

    if (data.nodes && data.nodes.length > 0) {
      html += '<h4 style="color: #94a3b8; margin-top: 20px;">Nodes</h4>';
      html += '<table><thead><tr><th>ID</th><th>Type</th><th>Attributes</th></tr></thead><tbody>';
      data.nodes.slice(0, 100).forEach(node => {
        const nodeId = ((node.id || 'N/A').toString().split('\n')[0]);
        const nodeType = ((node.type || 'N/A').toString().split('\n')[0]);
        html += `<tr>
          <td class="whitespace-nowrap">${nodeId}</td>
          <td class="whitespace-nowrap">${nodeType}</td>
          <td><pre style="max-width: 400px; overflow: auto; font-size: 0.85em;">${JSON.stringify(node.attributes || {}, null, 2)}</pre></td>
        </tr>`;
      });
      html += '</tbody></table>';
    }

    if (data.relationships && data.relationships.length > 0) {
      html += '<h4 style="color: #94a3b8; margin-top: 20px;">Relationships</h4>';
      html += '<table><thead><tr><th>From</th><th>Type</th><th>To</th></tr></thead><tbody>';
      data.relationships.slice(0, 100).forEach(rel => {
        html += `<tr>
          <td class="whitespace-nowrap">${((rel.from || 'N/A').toString().split('\n')[0])}</td>
          <td class="whitespace-nowrap">${((rel.type || 'N/A').toString().split('\n')[0])}</td>
          <td class="whitespace-nowrap">${((rel.to || 'N/A').toString().split('\n')[0])}</td>
        </tr>`;
      });
      html += '</tbody></table>';
    }

    resultsDiv.innerHTML = html;
  } catch (error) {
    resultsDiv.innerHTML = `<div class="error">Failed to execute Cypher query: ${error.message}</div>`;
  }
}

// Make globally accessible for onclick handlers
window.executeQuery = executeQuery;
window.executeGraphQuery = executeGraphQuery;
window.executeCypherQuery = executeCypherQuery;

