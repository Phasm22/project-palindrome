import { API_URL, escapeHtml, renderResponsiveTable } from './utils.js';

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

    let html = '<div class="results-section"><h3>Answer</h3>';
    html += `<div class="result-answer">${escapeHtml((data.answer || 'No answer provided').split('\n')[0])}</div></div>`;

    if (data.sources && data.sources.length > 0) {
      html += '<div class="results-section"><h3>Sources</h3>';
      html += renderResponsiveTable(
        ['Source', 'Score', 'Preview'],
        data.sources,
        (source) => {
          const sourcePath = ((source.sourcePath || source.chunkId || 'Unknown').split('\n')[0]);
          const preview = ((source.text || '').split('\n')[0]).substring(0, 100);
          return `<td class="whitespace-nowrap">${escapeHtml(sourcePath)}</td>
            <td class="whitespace-nowrap">${escapeHtml((source.score || 0).toFixed(4))}</td>
            <td class="max-w-md truncate" title="${escapeHtml(preview)}">${escapeHtml(preview)}${preview.length >= 100 ? '...' : ''}</td>`;
        }
      );
      html += '</div>';
    }

    if (data.sTotalScore !== null && data.sTotalScore !== undefined) {
      html += `<div class="result-meta">Total Score: ${escapeHtml(data.sTotalScore.toFixed(4))}</div>`;
    }

    resultsDiv.innerHTML = html;
  } catch (error) {
    resultsDiv.innerHTML = `<div class="error">Failed to execute query: ${escapeHtml(error.message)}</div>`;
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

    let html = '<div class="results-section"><h3>Graph Query Results</h3>';
    html += `<div class="result-meta">Found ${escapeHtml(String(data.nodes?.length || 0))} nodes, ${escapeHtml(String(data.relationships?.length || 0))} relationships</div></div>`;

    if (data.nodes && data.nodes.length > 0) {
      html += '<div class="results-section"><h3>Nodes</h3>';
      html += renderResponsiveTable(
        ['ID', 'Type', 'Attributes'],
        data.nodes.slice(0, 50),
        (node) => {
          const nodeId = ((node.id || 'N/A').toString().split('\n')[0]);
          const nodeType = ((node.type || 'N/A').toString().split('\n')[0]);
          return `<td class="whitespace-nowrap">${escapeHtml(nodeId)}</td>
            <td class="whitespace-nowrap">${escapeHtml(nodeType)}</td>
            <td><pre class="json-block table-json">${escapeHtml(JSON.stringify(node.attributes || {}, null, 2))}</pre></td>`;
        }
      );
      html += '</div>';
    }

    if (data.relationships && data.relationships.length > 0) {
      html += '<div class="results-section"><h3>Relationships</h3>';
      html += renderResponsiveTable(
        ['From', 'Type', 'To'],
        data.relationships.slice(0, 50),
        (rel) => `<td class="whitespace-nowrap">${escapeHtml((rel.from || 'N/A').toString().split('\n')[0])}</td>
          <td class="whitespace-nowrap">${escapeHtml((rel.type || 'N/A').toString().split('\n')[0])}</td>
          <td class="whitespace-nowrap">${escapeHtml((rel.to || 'N/A').toString().split('\n')[0])}</td>`
      );
      html += '</div>';
    }

    resultsDiv.innerHTML = html;
  } catch (error) {
    resultsDiv.innerHTML = `<div class="error">Failed to execute graph query: ${escapeHtml(error.message)}</div>`;
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

    let html = '<div class="results-section"><h3>Cypher Query Results</h3>';
    html += `<div class="result-meta">Found ${escapeHtml(String(data.nodes?.length || 0))} nodes, ${escapeHtml(String(data.relationships?.length || 0))} relationships</div></div>`;

    if (data.nodes && data.nodes.length > 0) {
      html += '<div class="results-section"><h3>Nodes</h3>';
      html += renderResponsiveTable(
        ['ID', 'Type', 'Attributes'],
        data.nodes.slice(0, 100),
        (node) => {
          const nodeId = ((node.id || 'N/A').toString().split('\n')[0]);
          const nodeType = ((node.type || 'N/A').toString().split('\n')[0]);
          return `<td class="whitespace-nowrap">${escapeHtml(nodeId)}</td>
            <td class="whitespace-nowrap">${escapeHtml(nodeType)}</td>
            <td><pre class="json-block table-json">${escapeHtml(JSON.stringify(node.attributes || {}, null, 2))}</pre></td>`;
        }
      );
      html += '</div>';
    }

    if (data.relationships && data.relationships.length > 0) {
      html += '<div class="results-section"><h3>Relationships</h3>';
      html += renderResponsiveTable(
        ['From', 'Type', 'To'],
        data.relationships.slice(0, 100),
        (rel) => `<td class="whitespace-nowrap">${escapeHtml((rel.from || 'N/A').toString().split('\n')[0])}</td>
          <td class="whitespace-nowrap">${escapeHtml((rel.type || 'N/A').toString().split('\n')[0])}</td>
          <td class="whitespace-nowrap">${escapeHtml((rel.to || 'N/A').toString().split('\n')[0])}</td>`
      );
      html += '</div>';
    }

    resultsDiv.innerHTML = html;
  } catch (error) {
    resultsDiv.innerHTML = `<div class="error">Failed to execute Cypher query: ${escapeHtml(error.message)}</div>`;
  }
}

// Make globally accessible for onclick handlers
window.executeQuery = executeQuery;
window.executeGraphQuery = executeGraphQuery;
window.executeCypherQuery = executeCypherQuery;
