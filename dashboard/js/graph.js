import { API_URL } from './utils.js';

export async function loadGraph() {
  const container = document.getElementById('graph-container');
  if (!container) return;
  
  container.innerHTML = '<div class="loading">Loading graph...</div>';
  
  try {
    const response = await fetch(`${API_URL}/api/dashboard/ontology-graph?limit=100`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    
    if (!data.nodes || data.nodes.length === 0) {
      document.getElementById('graph-container').innerHTML = 
        '<p>No graph data available. The ontology graph may be empty.</p>';
      return;
    }
    
    const nodes = data.nodes.map(n => ({
      id: n.id || n.properties?.id || Math.random().toString(),
      label: n.name || n.properties?.name || n.id || 'Unknown',
      group: n.type || n.labels?.[0] || 'unknown',
      title: JSON.stringify(n, null, 2),
    }));
    
    const edges = data.relationships.map(r => ({
      from: r.from || r.start,
      to: r.to || r.end,
      label: r.type || r.properties?.type || '',
      arrows: 'to',
    }));
    
    const visData = { nodes, edges };
    const options = {
      nodes: {
        shape: 'dot',
        size: 16,
        font: { color: '#e2e8f0' },
        borderWidth: 2,
      },
      edges: {
        arrows: { to: { enabled: true } },
        color: { color: '#60a5fa' },
        font: { color: '#94a3b8', size: 12 },
      },
      physics: {
        enabled: true,
        stabilization: { iterations: 100 },
      },
      interaction: {
        hover: true,
        tooltipDelay: 100,
      },
    };
    
    const container = document.getElementById('graph-container');
    container.innerHTML = '<div id="graph"></div>';
    new vis.Network(document.getElementById('graph'), visData, options);
  } catch (error) {
    document.getElementById('graph-container').innerHTML = 
      `<div class="error">Failed to load graph: ${error.message}</div>`;
  }
}

