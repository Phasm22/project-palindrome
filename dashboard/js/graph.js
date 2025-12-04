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
    
    // Calculate statistics
    const nodeTypes = {};
    const edgeTypes = {};
    nodes.forEach(n => {
      const type = n.group || 'unknown';
      nodeTypes[type] = (nodeTypes[type] || 0) + 1;
    });
    edges.forEach(e => {
      const type = e.label || 'unknown';
      edgeTypes[type] = (edgeTypes[type] || 0) + 1;
    });
    
    const totalNodes = nodes.length;
    const totalEdges = edges.length;
    const uniqueNodeTypes = Object.keys(nodeTypes).length;
    const uniqueEdgeTypes = Object.keys(edgeTypes).length;
    
    // Color mapping for node types
    const typeColors = {
      'compute-vm': '#3b82f6',
      'compute-node': '#10b981',
      'network': '#8b5cf6',
      'service': '#f59e0b',
      'storage': '#ef4444',
      'unknown': '#94a3b8',
    };
    
    const getColorForType = (type) => typeColors[type.toLowerCase()] || typeColors['unknown'];
    
    const visData = { nodes, edges };
    const options = {
      nodes: {
        shape: 'dot',
        size: 16,
        font: { color: '#e2e8f0' },
        borderWidth: 2,
        color: {
          border: '#334155',
          background: '#1e293b',
        },
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
    
    // Create layout with sidebar
    const html = `
      <div style="display: flex; gap: 15px; height: 100%; min-height: 500px;">
        <!-- Graph Visualization -->
        <div style="flex: 1; background: #0f172a; border: 1px solid #334155; border-radius: 4px; position: relative;">
          <div id="graph" style="width: 100%; height: 100%;"></div>
        </div>
        
        <!-- Statistics and Legend Sidebar -->
        <div style="width: 300px; display: flex; flex-direction: column; gap: 15px;">
          <!-- Statistics Panel -->
          <div style="background: #0f172a; border: 1px solid #334155; border-radius: 4px; padding: 15px;">
            <h3 style="margin: 0 0 15px 0; color: #e2e8f0; font-size: 16px;">Statistics</h3>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px;">
              <div style="padding: 10px; background: #1e293b; border-radius: 4px; text-align: center;">
                <div style="color: #94a3b8; font-size: 0.75em; margin-bottom: 4px;">Total Nodes</div>
                <div style="color: #e2e8f0; font-size: 1.5em; font-weight: 600;">${totalNodes}</div>
              </div>
              <div style="padding: 10px; background: #1e293b; border-radius: 4px; text-align: center;">
                <div style="color: #94a3b8; font-size: 0.75em; margin-bottom: 4px;">Total Edges</div>
                <div style="color: #e2e8f0; font-size: 1.5em; font-weight: 600;">${totalEdges}</div>
              </div>
              <div style="padding: 10px; background: #1e293b; border-radius: 4px; text-align: center;">
                <div style="color: #94a3b8; font-size: 0.75em; margin-bottom: 4px;">Node Types</div>
                <div style="color: #e2e8f0; font-size: 1.5em; font-weight: 600;">${uniqueNodeTypes}</div>
              </div>
              <div style="padding: 10px; background: #1e293b; border-radius: 4px; text-align: center;">
                <div style="color: #94a3b8; font-size: 0.75em; margin-bottom: 4px;">Edge Types</div>
                <div style="color: #e2e8f0; font-size: 1.5em; font-weight: 600;">${uniqueEdgeTypes}</div>
              </div>
            </div>
          </div>
          
          <!-- Node Types Legend -->
          <details style="background: #0f172a; border: 1px solid #334155; border-radius: 4px; padding: 15px;" open>
            <summary style="cursor: pointer; color: #e2e8f0; font-weight: 600; margin-bottom: 10px; font-size: 16px;">Node Types</summary>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              ${Object.entries(nodeTypes).sort((a, b) => b[1] - a[1]).map(([type, count]) => `
                <div style="display: flex; align-items: center; gap: 10px; padding: 8px; background: #1e293b; border-radius: 4px;">
                  <div style="width: 16px; height: 16px; border-radius: 50%; background: ${getColorForType(type)}; border: 2px solid #334155;"></div>
                  <div style="flex: 1; color: #e2e8f0; font-size: 0.9em;">${type}</div>
                  <div style="color: #94a3b8; font-size: 0.85em; font-weight: 600;">${count}</div>
                </div>
              `).join('')}
            </div>
          </details>
          
          <!-- Edge Types Legend -->
          <details style="background: #0f172a; border: 1px solid #334155; border-radius: 4px; padding: 15px;">
            <summary style="cursor: pointer; color: #e2e8f0; font-weight: 600; margin-bottom: 10px; font-size: 16px;">Relationship Types</summary>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              ${Object.entries(edgeTypes).sort((a, b) => b[1] - a[1]).map(([type, count]) => `
                <div style="display: flex; align-items: center; gap: 10px; padding: 8px; background: #1e293b; border-radius: 4px;">
                  <div style="width: 20px; height: 2px; background: #60a5fa;"></div>
                  <div style="flex: 1; color: #e2e8f0; font-size: 0.9em;">${type || 'unnamed'}</div>
                  <div style="color: #94a3b8; font-size: 0.85em; font-weight: 600;">${count}</div>
                </div>
              `).join('')}
            </div>
          </details>
          
          <!-- Info Panel -->
          <details style="background: #0f172a; border: 1px solid #334155; border-radius: 4px; padding: 15px;">
            <summary style="cursor: pointer; color: #e2e8f0; font-weight: 600; margin-bottom: 10px; font-size: 16px;">About</summary>
            <div style="color: #94a3b8; font-size: 0.875em; line-height: 1.6;">
              <p style="margin: 0 0 10px 0;">This graph visualizes the digital twin ontology, showing entities (nodes) and their relationships (edges).</p>
              <p style="margin: 0 0 10px 0;"><strong>Interactions:</strong></p>
              <ul style="margin: 0; padding-left: 20px;">
                <li>Drag nodes to reposition</li>
                <li>Hover over nodes/edges for details</li>
                <li>Zoom with mouse wheel</li>
                <li>Pan by dragging background</li>
              </ul>
            </div>
          </details>
        </div>
      </div>
    `;
    
    container.innerHTML = html;
    
    // Initialize graph after DOM is ready
    setTimeout(() => {
      const graphElement = document.getElementById('graph');
      if (graphElement) {
        new vis.Network(graphElement, visData, options);
      }
    }, 100);
  } catch (error) {
    document.getElementById('graph-container').innerHTML = 
      `<div class="error">Failed to load graph: ${error.message}</div>`;
  }
}

