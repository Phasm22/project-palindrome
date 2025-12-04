import { API_URL } from './utils.js';

// Cytoscape and Chroma are loaded via CDN in HTML
// Access them from window object
const cytoscape = window.cytoscape;
const chroma = window.chroma;

// Color palette - burnt orange theme with good contrast
const colorPalette = {
  primary: chroma('#f97316'), // Burnt orange
  primaryLight: chroma('#fb923c'),
  primaryDark: chroma('#c2410c'),
  secondary: chroma('#ea580c'),
  success: chroma('#10b981'),
  warning: chroma('#f59e0b'),
  error: chroma('#ef4444'),
  info: chroma('#3b82f6'),
  background: chroma('#0f172a'),
  surface: chroma('#1e293b'),
  text: chroma('#e2e8f0'),
  textMuted: chroma('#94a3b8'),
};

// Node type colors
const nodeTypeColors = {
  'compute-vm': colorPalette.primary,
  'compute-node': colorPalette.success,
  'network': colorPalette.secondary,
  'service': colorPalette.warning,
  'storage': colorPalette.error,
  'unknown': colorPalette.textMuted,
};

let cy = null; // Cytoscape instance
let graphData = null; // Store graph data for search/filter

export async function loadGraph() {
  const container = document.getElementById('graph-container');
  if (!container) return;
  
  container.innerHTML = '<div class="loading">Loading graph...</div>';
  
  try {
    const response = await fetch(`${API_URL}/api/dashboard/ontology-graph?limit=200`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    
    if (!data.nodes || data.nodes.length === 0) {
      container.innerHTML = '<p class="text-slate-400 text-center py-10">No graph data available. The ontology graph may be empty.</p>';
      return;
    }
    
    // Store data for search/filter
    graphData = data;
    
    // Calculate node degrees for sizing
    const nodeDegrees = {};
    data.relationships.forEach(rel => {
      nodeDegrees[rel.from] = (nodeDegrees[rel.from] || 0) + 1;
      nodeDegrees[rel.to] = (nodeDegrees[rel.to] || 0) + 1;
    });
    
    const maxDegree = Math.max(...Object.values(nodeDegrees), 1);
    
    // Transform data to Cytoscape format
    const nodes = data.nodes.map(n => {
      const nodeId = n.id || n.properties?.id || Math.random().toString();
      const nodeType = (n.type || n.labels?.[0] || 'unknown').toLowerCase();
      const degree = nodeDegrees[nodeId] || 0;
      const size = Math.max(20, 20 + (degree / maxDegree) * 40); // Size by degree: 20-60px
      
      const color = nodeTypeColors[nodeType] || nodeTypeColors['unknown'];
      
      return {
        data: {
          id: nodeId,
          label: n.name || n.properties?.name || n.id || 'Unknown',
          type: nodeType,
          degree: degree,
          ...n.properties,
        },
        style: {
          'background-color': color.hex(),
          'width': size,
          'height': size,
          'label': 'data(label)',
          'font-size': Math.max(12, Math.min(16, size * 0.4)) + 'px',
          'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          'font-weight': degree > maxDegree * 0.5 ? '600' : '400',
          'color': colorPalette.text.hex(),
          'text-outline-color': colorPalette.background.hex(),
          'text-outline-width': 2,
          'border-width': 2,
          'border-color': color.darken(0.3).hex(),
        },
      };
    });
    
    const edges = data.relationships.map(r => ({
      data: {
        id: `${r.from}-${r.to}-${r.type || 'rel'}`,
        source: r.from || r.start,
        target: r.to || r.end,
        label: r.type || r.properties?.type || '',
        type: r.type || 'unknown',
      },
      style: {
        'width': 2,
        'line-color': colorPalette.primary.alpha(0.6).hex(),
        'target-arrow-color': colorPalette.primary.hex(),
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'font-size': '11px',
        'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        'color': colorPalette.textMuted.hex(),
        'text-outline-color': colorPalette.background.hex(),
        'text-outline-width': 1,
      },
    }));
    
    // Calculate statistics
    const nodeTypes = {};
    const edgeTypes = {};
    nodes.forEach(n => {
      const type = n.data.type || 'unknown';
      nodeTypes[type] = (nodeTypes[type] || 0) + 1;
    });
    edges.forEach(e => {
      const type = e.data.type || 'unknown';
      edgeTypes[type] = (edgeTypes[type] || 0) + 1;
    });
    
    const totalNodes = nodes.length;
    const totalEdges = edges.length;
    const uniqueNodeTypes = Object.keys(nodeTypes).length;
    const uniqueEdgeTypes = Object.keys(edgeTypes).length;
    
    // Create layout HTML
    const html = `
      <div class="flex gap-4" style="height: 800px;">
        <!-- Graph Visualization -->
        <div class="flex-1 bg-slate-950 border border-slate-700 rounded-lg relative" style="height: 800px; overflow: hidden; position: relative;">
          <!-- Zoom Controls -->
          <div class="absolute top-4 right-4 z-10 flex flex-col gap-2">
            <button id="zoom-in" class="bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 px-3 py-2 rounded-lg text-sm font-medium transition-colors shadow-lg" title="Zoom In">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
              </svg>
            </button>
            <button id="zoom-out" class="bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 px-3 py-2 rounded-lg text-sm font-medium transition-colors shadow-lg" title="Zoom Out">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 13H5v-2h14v2z"/>
              </svg>
            </button>
            <button id="zoom-fit" class="bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 px-3 py-2 rounded-lg text-sm font-medium transition-colors shadow-lg" title="Fit to Screen">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z"/>
              </svg>
            </button>
            <button id="zoom-reset" class="bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 px-3 py-2 rounded-lg text-sm font-medium transition-colors shadow-lg" title="Reset View">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
              </svg>
            </button>
          </div>
          
          <!-- Search Box -->
          <div class="absolute top-4 left-4 z-10 w-64">
            <input 
              type="text" 
              id="node-search" 
              placeholder="Search nodes..." 
              class="w-full px-4 py-2 bg-slate-800 border border-slate-600 rounded-lg text-slate-200 placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
            <div id="search-results" class="mt-2 bg-slate-800 border border-slate-600 rounded-lg max-h-48 overflow-y-auto hidden"></div>
          </div>
          
          <div id="cy" style="width: 100%; height: 100%;"></div>
        </div>
        
        <!-- Statistics and Legend Sidebar -->
        <div class="w-80 flex flex-col gap-4 overflow-y-auto" style="max-height: 800px;">
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
              ${Object.entries(nodeTypes).sort((a, b) => b[1] - a[1]).map(([type, count]) => {
                const color = nodeTypeColors[type] || nodeTypeColors['unknown'];
                return `
                <div class="flex items-center gap-3 p-2 bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer" data-filter-type="${type}">
                  <div class="w-4 h-4 rounded-full" style="background: ${color.hex()}; border: 2px solid #334155;"></div>
                  <div class="flex-1 text-slate-200 text-sm">${type}</div>
                  <div class="text-slate-400 text-xs font-semibold">${count}</div>
                </div>
              `;
              }).join('')}
            </div>
          </details>
          
          <!-- Edge Types Legend -->
          <details class="bg-slate-950 border border-slate-700 rounded-lg p-4">
            <summary class="cursor-pointer text-slate-200 font-semibold mb-3 text-base">Relationship Types</summary>
            <div class="flex flex-col gap-2">
              ${Object.entries(edgeTypes).sort((a, b) => b[1] - a[1]).map(([type, count]) => `
                <div class="flex items-center gap-3 p-2 bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer" data-filter-edge="${type}">
                  <div class="w-5 h-0.5" style="background: ${colorPalette.primary.hex()};"></div>
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
                <li>Click nodes to select</li>
                <li>Hover over nodes/edges for details</li>
                <li>Zoom with mouse wheel or buttons</li>
                <li>Pan by dragging background</li>
                <li>Search nodes using the search box</li>
                <li>Filter by clicking legend items</li>
              </ul>
            </div>
          </details>
        </div>
      </div>
    `;
    
    container.innerHTML = html;
    
    // Initialize Cytoscape after DOM is ready
    setTimeout(() => {
      initCytoscape(nodes, edges);
      setupControls();
      setupSearch();
      setupFilters();
    }, 100);
  } catch (error) {
    container.innerHTML = 
      `<div class="error">Failed to load graph: ${error.message}</div>`;
  }
}

function initCytoscape(nodes, edges) {
  const cyContainer = document.getElementById('cy');
  if (!cyContainer) return;
  
  // Check if cytoscape is loaded
  if (!cytoscape || !chroma) {
    console.error('Cytoscape or Chroma not loaded. Make sure CDN scripts are included.');
    return;
  }
  
  // Destroy existing instance
  if (cy) {
    cy.destroy();
  }
  
  cy = cytoscape({
    container: cyContainer,
    elements: [...nodes, ...edges],
    style: [
      {
        selector: 'node',
        style: {
          'background-color': 'data(backgroundColor)',
          'width': 'data(width)',
          'height': 'data(height)',
          'label': 'data(label)',
          'font-size': 'data(fontSize)',
          'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          'font-weight': 'data(fontWeight)',
          'color': colorPalette.text.hex(),
          'text-outline-color': colorPalette.background.hex(),
          'text-outline-width': 2,
          'border-width': 2,
          'border-color': 'data(borderColor)',
          'text-valign': 'center',
          'text-halign': 'center',
          'overlay-padding': '6px',
        },
      },
      {
        selector: 'node:selected',
        style: {
          'border-width': 4,
          'border-color': colorPalette.primary.hex(),
          'background-color': colorPalette.primaryLight.hex(),
        },
      },
      {
        selector: 'edge',
        style: {
          'width': 2,
          'line-color': colorPalette.primary.alpha(0.6).hex(),
          'target-arrow-color': colorPalette.primary.hex(),
          'target-arrow-shape': 'triangle',
          'curve-style': 'bezier',
          'label': 'data(label)',
          'font-size': '11px',
          'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          'color': colorPalette.textMuted.hex(),
          'text-outline-color': colorPalette.background.hex(),
          'text-outline-width': 1,
          'text-rotation': 'autorotate',
          'text-margin-y': -10,
        },
      },
      {
        selector: 'edge:selected',
        style: {
          'width': 4,
          'line-color': colorPalette.primary.hex(),
        },
      },
    ],
    layout: {
      name: 'cose',
      idealEdgeLength: 100,
      nodeOverlap: 20,
      refresh: 1,
      fit: true,
      padding: 30,
      randomize: false,
      componentSpacing: 40,
      nodeRepulsion: 4500,
      edgeElasticity: 100,
      nestingFactor: 5,
      gravity: 0.25,
      numIter: 2500,
      initialTemp: 200,
      coolingFactor: 0.95,
      minTemp: 1.0,
      animate: true,
      animationDuration: 1000,
      animationEasing: 'ease-out',
    },
    minZoom: 0.1,
    maxZoom: 3,
    wheelSensitivity: 0.2,
  });
  
  // Smooth animations
  cy.on('tap', 'node', function(evt) {
    const node = evt.target;
    cy.animate({
      center: { eles: node },
      zoom: Math.min(cy.zoom() * 1.5, 2),
    }, {
      duration: 300,
      easing: 'ease-out',
    });
  });
  
  // Tooltip on hover
  cy.on('mouseover', 'node', function(evt) {
    const node = evt.target;
    const data = node.data();
    const tooltip = document.createElement('div');
    tooltip.className = 'graph-tooltip';
    tooltip.style.cssText = `
      position: absolute;
      background: ${colorPalette.surface.hex()};
      color: ${colorPalette.text.hex()};
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid ${colorPalette.primary.alpha(0.5).hex()};
      font-size: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      z-index: 1000;
      pointer-events: none;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
      max-width: 300px;
    `;
    
    let tooltipContent = `<strong>${data.label || data.id}</strong><br>`;
    tooltipContent += `<span style="color: ${colorPalette.textMuted.hex()}">Type:</span> ${data.type || 'unknown'}<br>`;
    tooltipContent += `<span style="color: ${colorPalette.textMuted.hex()}">Degree:</span> ${data.degree || 0}<br>`;
    if (data.id) tooltipContent += `<span style="color: ${colorPalette.textMuted.hex()}">ID:</span> ${data.id}<br>`;
    if (data.purpose) tooltipContent += `<span style="color: ${colorPalette.textMuted.hex()}">Purpose:</span> ${data.purpose}<br>`;
    if (data.role) tooltipContent += `<span style="color: ${colorPalette.textMuted.hex()}">Role:</span> ${data.role}<br>`;
    
    tooltip.innerHTML = tooltipContent;
    document.body.appendChild(tooltip);
    
    const updateTooltip = (e) => {
      tooltip.style.left = (e.originalEvent.clientX + 10) + 'px';
      tooltip.style.top = (e.originalEvent.clientY + 10) + 'px';
    };
    
    cy.on('mousemove', updateTooltip);
    cy.on('mouseout', 'node', function() {
      tooltip.remove();
      cy.off('mousemove', updateTooltip);
    });
  });
}

function setupControls() {
  document.getElementById('zoom-in')?.addEventListener('click', () => {
    cy.animate({
      zoom: cy.zoom() * 1.2,
    }, {
      duration: 200,
      easing: 'ease-out',
    });
  });
  
  document.getElementById('zoom-out')?.addEventListener('click', () => {
    cy.animate({
      zoom: cy.zoom() * 0.8,
    }, {
      duration: 200,
      easing: 'ease-out',
    });
  });
  
  document.getElementById('zoom-fit')?.addEventListener('click', () => {
    cy.animate({
      fit: true,
      padding: 50,
    }, {
      duration: 400,
      easing: 'ease-out',
    });
  });
  
  document.getElementById('zoom-reset')?.addEventListener('click', () => {
    cy.animate({
      center: { x: 0, y: 0 },
      zoom: 1,
    }, {
      duration: 400,
      easing: 'ease-out',
    });
  });
}

function setupSearch() {
  const searchInput = document.getElementById('node-search');
  const resultsDiv = document.getElementById('search-results');
  
  if (!searchInput || !resultsDiv) return;
  
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const query = e.target.value.toLowerCase().trim();
    
    if (query.length < 2) {
      resultsDiv.classList.add('hidden');
      cy.elements().removeClass('search-highlight');
      return;
    }
    
    searchTimeout = setTimeout(() => {
      const matchingNodes = cy.nodes().filter(node => {
        const data = node.data();
        const label = (data.label || '').toLowerCase();
        const id = (data.id || '').toLowerCase();
        const type = (data.type || '').toLowerCase();
        return label.includes(query) || id.includes(query) || type.includes(query);
      });
      
      // Highlight matching nodes
      cy.elements().removeClass('search-highlight');
      matchingNodes.addClass('search-highlight');
      
      // Style for highlighted nodes
      cy.style()
        .selector('.search-highlight')
        .style({
          'border-width': 4,
          'border-color': colorPalette.warning.hex(),
        })
        .update();
      
      // Show results
      if (matchingNodes.length > 0) {
        resultsDiv.innerHTML = matchingNodes.map(node => {
          const data = node.data();
          return `
            <div class="p-2 hover:bg-slate-700 cursor-pointer text-slate-200 text-sm border-b border-slate-700" 
                 data-node-id="${data.id}">
              <div class="font-medium">${data.label || data.id}</div>
              <div class="text-xs text-slate-400">${data.type || 'unknown'}</div>
            </div>
          `;
        }).join('');
        resultsDiv.classList.remove('hidden');
        
        // Click handler for results
        resultsDiv.querySelectorAll('[data-node-id]').forEach(el => {
          el.addEventListener('click', () => {
            const nodeId = el.getAttribute('data-node-id');
            const node = cy.getElementById(nodeId);
            if (node.length > 0) {
              cy.animate({
                center: { eles: node },
                zoom: Math.min(cy.zoom() * 1.5, 2),
              }, {
                duration: 400,
                easing: 'ease-out',
              });
              node.select();
            }
          });
        });
      } else {
        resultsDiv.innerHTML = '<div class="p-2 text-slate-400 text-sm">No results found</div>';
        resultsDiv.classList.remove('hidden');
      }
    }, 300);
  });
}

function setupFilters() {
  // Filter by node type
  document.querySelectorAll('[data-filter-type]').forEach(el => {
    el.addEventListener('click', () => {
      const type = el.getAttribute('data-filter-type');
      const nodes = cy.nodes(`[type = "${type}"]`);
      const edges = cy.edges().connected(nodes);
      
      cy.elements().removeClass('filtered');
      cy.elements().not(nodes).not(edges).addClass('filtered');
      
      cy.style()
        .selector('.filtered')
        .style({
          'opacity': 0.2,
        })
        .update();
      
      cy.animate({
        fit: { eles: nodes },
        padding: 50,
      }, {
        duration: 400,
        easing: 'ease-out',
      });
    });
  });
  
  // Filter by edge type
  document.querySelectorAll('[data-filter-edge]').forEach(el => {
    el.addEventListener('click', () => {
      const type = el.getAttribute('data-filter-edge');
      const edges = cy.edges(`[type = "${type}"]`);
      const nodes = edges.connectedNodes();
      
      cy.elements().removeClass('filtered');
      cy.elements().not(nodes).not(edges).addClass('filtered');
      
      cy.style()
        .selector('.filtered')
        .style({
          'opacity': 0.2,
        })
        .update();
      
      cy.animate({
        fit: { eles: nodes },
        padding: 50,
      }, {
        duration: 400,
        easing: 'ease-out',
      });
    });
  });
  
  // Reset filter on double-click
  document.addEventListener('dblclick', () => {
    cy.elements().removeClass('filtered');
    cy.style()
      .selector('.filtered')
      .style({
        'opacity': 1,
      })
      .update();
  });
}
