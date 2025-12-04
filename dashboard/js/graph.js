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
    
    // Format node info for tooltip
    const formatNodeInfo = (node) => {
      const props = node.properties || {};
      const info = [];
      if (node.name || props.name) info.push(`<strong>Name:</strong> ${node.name || props.name}`);
      if (node.type || node.labels?.[0]) info.push(`<strong>Type:</strong> ${node.type || node.labels?.[0]}`);
      if (node.id || props.id) info.push(`<strong>ID:</strong> ${node.id || props.id}`);
      if (props.purpose) info.push(`<strong>Purpose:</strong> ${props.purpose}`);
      if (props.role) info.push(`<strong>Role:</strong> ${props.role}`);
      if (props.status) info.push(`<strong>Status:</strong> ${props.status}`);
      if (props.ip) info.push(`<strong>IP:</strong> ${props.ip}`);
      return info.length > 0 ? info.join('<br>') : 'No additional information';
    };
    
    const nodes = data.nodes.map(n => ({
      id: n.id || n.properties?.id || Math.random().toString(),
      label: n.name || n.properties?.name || n.id || 'Unknown',
      group: n.type || n.labels?.[0] || 'unknown',
      title: formatNodeInfo(n),
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
      'compute-vm': '#f97316',
      'compute-node': '#10b981',
      'network': '#ea580c',
      'service': '#f59e0b',
      'storage': '#ef4444',
      'unknown': '#94a3b8',
    };
    
    const getColorForType = (type) => typeColors[type.toLowerCase()] || typeColors['unknown'];
    
    const visData = { nodes, edges };
    const options = {
      nodes: {
        shape: 'dot',
        size: 20,
        font: { color: '#e2e8f0', size: 14 },
        borderWidth: 2,
        color: {
          border: '#334155',
          background: '#1e293b',
        },
      },
      edges: {
        arrows: { to: { enabled: true } },
        color: { color: '#f97316' },
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
      height: '100%',
      width: '100%',
    };
    
    // Create layout with sidebar
    const html = `
      <div class="flex gap-4 h-full min-h-[600px]">
        <!-- Graph Visualization -->
        <div class="flex-1 bg-slate-950 border border-slate-700 rounded-lg relative min-h-[600px]">
          <div id="graph" class="w-full h-full" style="min-height: 600px;"></div>
        </div>
        
        <!-- Statistics and Legend Sidebar -->
        <div class="w-80 flex flex-col gap-4">
          <!-- Statistics Panel -->
          <div class="bg-slate-950 border border-slate-700 rounded-lg p-4">
            <h3 class="m-0 mb-4 text-slate-200 text-base font-semibold">Statistics</h3>
            <div class="grid grid-cols-2 gap-3 mb-4">
              <div class="p-3 bg-slate-900 rounded-lg text-center">
                <div class="text-slate-400 text-xs mb-1">Total Nodes</div>
                <div class="text-slate-100 text-2xl font-bold">${totalNodes}</div>
              </div>
              <div class="p-3 bg-slate-900 rounded-lg text-center">
                <div class="text-slate-400 text-xs mb-1">Total Edges</div>
                <div class="text-slate-100 text-2xl font-bold">${totalEdges}</div>
              </div>
              <div class="p-3 bg-slate-900 rounded-lg text-center">
                <div class="text-slate-400 text-xs mb-1">Node Types</div>
                <div class="text-slate-100 text-2xl font-bold">${uniqueNodeTypes}</div>
              </div>
              <div class="p-3 bg-slate-900 rounded-lg text-center">
                <div class="text-slate-400 text-xs mb-1">Edge Types</div>
                <div class="text-slate-100 text-2xl font-bold">${uniqueEdgeTypes}</div>
              </div>
            </div>
          </div>
          
          <!-- Node Types Legend -->
          <details class="bg-slate-950 border border-slate-700 rounded-lg p-4" open>
            <summary class="cursor-pointer text-slate-200 font-semibold mb-3 text-base">Node Types</summary>
            <div class="flex flex-col gap-2">
              ${Object.entries(nodeTypes).sort((a, b) => b[1] - a[1]).map(([type, count]) => `
                <div class="flex items-center gap-3 p-2 bg-slate-900 rounded-lg">
                  <div class="w-4 h-4 rounded-full" style="background: ${getColorForType(type)}; border: 2px solid #334155;"></div>
                  <div class="flex-1 text-slate-200 text-sm">${type}</div>
                  <div class="text-slate-400 text-xs font-semibold">${count}</div>
                </div>
              `).join('')}
            </div>
          </details>
          
          <!-- Edge Types Legend -->
          <details class="bg-slate-950 border border-slate-700 rounded-lg p-4">
            <summary class="cursor-pointer text-slate-200 font-semibold mb-3 text-base">Relationship Types</summary>
            <div class="flex flex-col gap-2">
              ${Object.entries(edgeTypes).sort((a, b) => b[1] - a[1]).map(([type, count]) => `
                <div class="flex items-center gap-3 p-2 bg-slate-900 rounded-lg">
                  <div class="w-5 h-0.5" style="background: #f97316;"></div>
                  <div class="flex-1 text-slate-200 text-sm">${type || 'unnamed'}</div>
                  <div class="text-slate-400 text-xs font-semibold">${count}</div>
                </div>
              `).join('')}
            </div>
          </details>
          
          <!-- Info Panel -->
          <details class="bg-slate-950 border border-slate-700 rounded-lg p-4">
            <summary class="cursor-pointer text-slate-200 font-semibold mb-3 text-base">About</summary>
            <div class="text-slate-400 text-sm leading-relaxed">
              <p class="m-0 mb-3">This graph visualizes the digital twin ontology, showing entities (nodes) and their relationships (edges).</p>
              <p class="m-0 mb-2 font-semibold">Interactions:</p>
              <ul class="m-0 pl-5 list-disc">
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

