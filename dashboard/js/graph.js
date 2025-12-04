import { API_URL } from './utils.js';

// Color palette - burnt orange theme
const colorPalette = {
  primary: '#f97316',
  primaryLight: '#fb923c',
  primaryDark: '#c2410c',
  secondary: '#ea580c',
  success: '#10b981',
  warning: '#f59e0b',
  error: '#ef4444',
  background: '#0f172a',
  surface: '#1e293b',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
};

// Node type colors
const nodeTypeColors = {
  'compute-vm': colorPalette.primary,
  'compute-node': colorPalette.success,
  'network': colorPalette.secondary,
  'service': colorPalette.warning,
  'storage': colorPalette.error,
  'entity': colorPalette.primary,
  'twinentity': colorPalette.secondary,
  'unknown': colorPalette.textMuted,
};

let sigma = null;
let graph = null;

export async function loadGraph() {
  const container = document.getElementById('graph-container');
  if (!container) return;
  
  // Check if libraries are loaded - try multiple possible global names
  // Graphology is exposed as window.graphology (from our UMD build)
  // It exports Graph as a property
  const Graph = window.graphology?.Graph || window.Graph;
  // Sigma is exposed as window.Sigma (uppercase) in the minified build
  const Sigma = window.Sigma;
  
  if (!Graph || !Sigma) {
    // Debug: log what's actually available
    console.error('Library check failed:', {
      Graph: !!Graph,
      Sigma: !!Sigma,
      windowGraph: !!window.Graph,
      windowGraphology: !!window.graphology,
      windowSigma: !!window.sigma,
      windowSigmaUpper: !!window.Sigma
    });
    container.innerHTML = '<div class="error p-4 bg-red-900/20 border border-red-500 rounded text-red-300">Sigma.js or Graphology not loaded. Please refresh the page.<br>Graph: ' + (Graph ? 'loaded' : 'missing') + ', Sigma: ' + (Sigma ? 'loaded' : 'missing') + '</div>';
    return;
  }
  
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
    
    // Calculate node degrees for sizing
    const nodeDegrees = {};
    data.relationships.forEach(rel => {
      nodeDegrees[rel.from] = (nodeDegrees[rel.from] || 0) + 1;
      nodeDegrees[rel.to] = (nodeDegrees[rel.to] || 0) + 1;
    });
    
    const maxDegree = Math.max(...Object.values(nodeDegrees), 1);
    
    // Create Graphology graph
    graph = new Graph();
    
    // Add nodes
    data.nodes.forEach(n => {
      const nodeId = n.id || n.properties?.id || Math.random().toString();
      const nodeType = (n.type || n.labels?.[0] || 'unknown').toLowerCase();
      const degree = nodeDegrees[nodeId] || 0;
      const size = Math.max(8, Math.min(30, 8 + (degree / maxDegree) * 22)); // Size by degree: 8-30px
      
      const color = nodeTypeColors[nodeType] || nodeTypeColors['unknown'];
      
      graph.addNode(nodeId, {
        label: n.name || n.properties?.name || n.id || 'Unknown',
        size: size,
        color: color,
        type: nodeType,
        degree: degree,
        x: Math.random() * 1000,
        y: Math.random() * 1000,
        ...n.properties,
      });
    });
    
    // Add edges
    data.relationships.forEach(r => {
      const from = r.from || r.start;
      const to = r.to || r.end;
      if (graph.hasNode(from) && graph.hasNode(to)) {
        try {
          graph.addEdge(from, to, {
            label: r.type || r.properties?.type || '',
            type: r.type || 'unknown',
            color: colorPalette.primary,
            size: 2,
          });
        } catch (e) {
          // Edge might already exist, skip
        }
      }
    });
    
    // Calculate statistics
    const nodeTypes = {};
    const edgeTypes = {};
    graph.forEachNode((node, attrs) => {
      const type = attrs.type || 'unknown';
      nodeTypes[type] = (nodeTypes[type] || 0) + 1;
    });
    graph.forEachEdge((edge, attrs) => {
      const type = attrs.type || 'unknown';
      edgeTypes[type] = (edgeTypes[type] || 0) + 1;
    });
    
    const totalNodes = graph.order;
    const totalEdges = graph.size;
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
          
          <div id="sigma-container" style="width: 100%; height: 100%;"></div>
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
                  <div class="w-4 h-4 rounded-full" style="background: ${color}; border: 2px solid #334155;"></div>
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
                  <div class="w-5 h-0.5" style="background: ${colorPalette.primary};"></div>
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
    
    // Initialize Sigma after DOM is ready
    setTimeout(() => {
      initSigma();
      setupControls();
      setupSearch();
      setupFilters();
    }, 100);
  } catch (error) {
    container.innerHTML = 
      `<div class="error">Failed to load graph: ${error.message}</div>`;
  }
}

function initSigma() {
  const container = document.getElementById('sigma-container');
  if (!container || !graph) return;
  
  // Destroy existing instance
  if (sigma) {
    sigma.kill();
    sigma = null;
  }
  
  // Initialize Sigma
  sigma = new Sigma(graph, container, {
    renderLabels: true,
    labelFont: 'Inter, system-ui, sans-serif',
    labelSize: 12,
    labelWeight: 'normal',
    labelColor: { attribute: 'color', defaultValue: colorPalette.text },
    defaultNodeColor: colorPalette.primary,
    defaultEdgeColor: colorPalette.primary,
    minCameraRatio: 0.1,
    maxCameraRatio: 10,
    allowInvalidContainer: true,
  });
  
  // Run ForceAtlas2 layout - try multiple possible global names
  const forceAtlas2 = window.graphologyLayoutForceAtlas2 || 
                      window.forceAtlas2 || 
                      window.graphologyLayoutForceatlas2 ||
                      (window.graphologyLayout && window.graphologyLayout.forceAtlas2);
  
  if (forceAtlas2) {
    try {
      // ForceAtlas2 API: inferSettings and assign
      const settings = forceAtlas2.inferSettings ? forceAtlas2.inferSettings(graph) : {
        gravity: 0.5,
        scalingRatio: 2,
        strongGravityMode: false,
        barnesHutOptimize: true,
        edgeWeightInfluence: 1,
        adjustSizes: true,
        outboundAttractionDistribution: false,
        linLogMode: false,
      };
      
      if (forceAtlas2.assign) {
        // Use assign method (runs synchronously)
        forceAtlas2.assign(graph, { settings, iterations: 100 });
        sigma.refresh();
      } else {
        // Fallback: try direct function call
        const layoutFn = forceAtlas2.default || forceAtlas2;
        const positions = layoutFn(graph, {
          iterations: 100,
          settings: settings,
        });
        
        // Apply positions
        graph.forEachNode((node, attrs) => {
          const pos = positions[node];
          if (pos) {
            attrs.x = pos.x;
            attrs.y = pos.y;
          }
        });
        
        sigma.refresh();
      }
    } catch (e) {
      console.warn('ForceAtlas2 layout failed, using random layout:', e);
      // Fallback: random layout
      graph.forEachNode((node, attrs) => {
        attrs.x = (Math.random() - 0.5) * 2000;
        attrs.y = (Math.random() - 0.5) * 2000;
      });
      sigma.refresh();
    }
  } else {
    console.warn('ForceAtlas2 not available, using random layout');
    // Fallback: random layout if ForceAtlas2 not available
    graph.forEachNode((node, attrs) => {
      attrs.x = (Math.random() - 0.5) * 2000;
      attrs.y = (Math.random() - 0.5) * 2000;
    });
    sigma.refresh();
  }
  
  // Node hover tooltip
  sigma.on('enterNode', ({ node }) => {
    const nodeData = graph.getNodeAttributes(node);
    const tooltip = document.createElement('div');
    tooltip.className = 'graph-tooltip';
    tooltip.style.cssText = `
      position: absolute;
      background: ${colorPalette.surface};
      color: ${colorPalette.text};
      padding: 8px 12px;
      border-radius: 6px;
      border: 1px solid ${colorPalette.primary};
      font-size: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      z-index: 1000;
      pointer-events: none;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
      max-width: 300px;
    `;
    
    let tooltipContent = `<strong>${nodeData.label || node}</strong><br>`;
    tooltipContent += `<span style="color: ${colorPalette.textMuted}">Type:</span> ${nodeData.type || 'unknown'}<br>`;
    tooltipContent += `<span style="color: ${colorPalette.textMuted}">Degree:</span> ${nodeData.degree || 0}<br>`;
    if (nodeData.id) tooltipContent += `<span style="color: ${colorPalette.textMuted}">ID:</span> ${nodeData.id}<br>`;
    if (nodeData.purpose) tooltipContent += `<span style="color: ${colorPalette.textMuted}">Purpose:</span> ${nodeData.purpose}<br>`;
    if (nodeData.role) tooltipContent += `<span style="color: ${colorPalette.textMuted}">Role:</span> ${nodeData.role}<br>`;
    
    tooltip.innerHTML = tooltipContent;
    document.body.appendChild(tooltip);
    
    const updateTooltip = (e) => {
      tooltip.style.left = (e.clientX + 10) + 'px';
      tooltip.style.top = (e.clientY + 10) + 'px';
    };
    
    container.addEventListener('mousemove', updateTooltip);
    sigma.once('leaveNode', () => {
      tooltip.remove();
      container.removeEventListener('mousemove', updateTooltip);
    });
  });
  
  // Node click to center
  sigma.on('clickNode', ({ node }) => {
    const nodePosition = sigma.getNodeDisplayData(node);
    sigma.getCamera().animate({
      x: nodePosition.x,
      y: nodePosition.y,
      ratio: Math.min(sigma.getCamera().ratio * 0.7, 2),
    }, {
      duration: 300,
    });
  });
}

function setupControls() {
  if (!sigma) return;
  
  document.getElementById('zoom-in')?.addEventListener('click', () => {
    const camera = sigma.getCamera();
    camera.animate({
      ratio: camera.ratio * 0.8,
    }, {
      duration: 200,
    });
  });
  
  document.getElementById('zoom-out')?.addEventListener('click', () => {
    const camera = sigma.getCamera();
    camera.animate({
      ratio: camera.ratio * 1.25,
    }, {
      duration: 200,
    });
  });
  
  document.getElementById('zoom-fit')?.addEventListener('click', () => {
    sigma.getCamera().animatedReset({ duration: 400 });
  });
  
  document.getElementById('zoom-reset')?.addEventListener('click', () => {
    sigma.getCamera().animate({
      x: 0,
      y: 0,
      ratio: 1,
    }, {
      duration: 400,
    });
  });
}

function setupSearch() {
  const searchInput = document.getElementById('node-search');
  const resultsDiv = document.getElementById('search-results');
  
  if (!searchInput || !resultsDiv || !graph || !sigma) return;
  
  let searchTimeout;
  let highlightedNodes = new Set();
  
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const query = e.target.value.toLowerCase().trim();
    
    if (query.length < 2) {
      resultsDiv.classList.add('hidden');
      // Reset highlights
      highlightedNodes.forEach(node => {
        graph.setNodeAttribute(node, 'highlighted', false);
        graph.setNodeAttribute(node, 'color', graph.getNodeAttribute(node, 'originalColor') || nodeTypeColors[graph.getNodeAttribute(node, 'type')] || nodeTypeColors['unknown']);
      });
      highlightedNodes.clear();
      sigma.refresh();
      return;
    }
    
    searchTimeout = setTimeout(() => {
      const matchingNodes = [];
      graph.forEachNode((node, attrs) => {
        const label = (attrs.label || '').toLowerCase();
        const id = (node || '').toLowerCase();
        const type = (attrs.type || '').toLowerCase();
        if (label.includes(query) || id.includes(query) || type.includes(query)) {
          matchingNodes.push({ node, attrs });
        }
      });
      
      // Reset previous highlights
      highlightedNodes.forEach(node => {
        graph.setNodeAttribute(node, 'highlighted', false);
        graph.setNodeAttribute(node, 'color', graph.getNodeAttribute(node, 'originalColor') || nodeTypeColors[graph.getNodeAttribute(node, 'type')] || nodeTypeColors['unknown']);
      });
      highlightedNodes.clear();
      
      // Highlight matching nodes
      matchingNodes.forEach(({ node }) => {
        if (!graph.getNodeAttribute(node, 'originalColor')) {
          graph.setNodeAttribute(node, 'originalColor', graph.getNodeAttribute(node, 'color'));
        }
        graph.setNodeAttribute(node, 'highlighted', true);
        graph.setNodeAttribute(node, 'color', colorPalette.warning);
        highlightedNodes.add(node);
      });
      
      sigma.refresh();
      
      // Show results
      if (matchingNodes.length > 0) {
        resultsDiv.innerHTML = matchingNodes.slice(0, 20).map(({ node, attrs }) => {
          return `
            <div class="p-2 hover:bg-slate-700 cursor-pointer text-slate-200 text-sm border-b border-slate-700" 
                 data-node-id="${node}">
              <div class="font-medium">${attrs.label || node}</div>
              <div class="text-xs text-slate-400">${attrs.type || 'unknown'}</div>
            </div>
          `;
        }).join('');
        resultsDiv.classList.remove('hidden');
        
        // Click handler for results
        resultsDiv.querySelectorAll('[data-node-id]').forEach(el => {
          el.addEventListener('click', () => {
            const nodeId = el.getAttribute('data-node-id');
            const nodePosition = sigma.getNodeDisplayData(nodeId);
            if (nodePosition) {
              sigma.getCamera().animate({
                x: nodePosition.x,
                y: nodePosition.y,
                ratio: Math.min(sigma.getCamera().ratio * 0.7, 2),
              }, {
                duration: 400,
              });
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
  if (!graph || !sigma) return;
  
  // Filter by node type
  document.querySelectorAll('[data-filter-type]').forEach(el => {
    el.addEventListener('click', () => {
      const type = el.getAttribute('data-filter-type');
      const nodesToShow = new Set();
      
      graph.forEachNode((node, attrs) => {
        if (attrs.type === type) {
          nodesToShow.add(node);
          // Add connected nodes
          graph.forEachNeighbor(node, neighbor => {
            nodesToShow.add(neighbor);
          });
        }
      });
      
      // Hide nodes not in filter
      graph.forEachNode((node) => {
        graph.setNodeAttribute(node, 'hidden', !nodesToShow.has(node));
      });
      
      sigma.refresh();
      
      // Fit to visible nodes
      if (nodesToShow.size > 0) {
        const nodeArray = Array.from(nodesToShow);
        const positions = nodeArray.map(node => {
          const pos = sigma.getNodeDisplayData(node);
          return pos ? { x: pos.x, y: pos.y } : null;
        }).filter(Boolean);
        
        if (positions.length > 0) {
          const bounds = positions.reduce((acc, pos) => {
            return {
              minX: Math.min(acc.minX, pos.x),
              maxX: Math.max(acc.maxX, pos.x),
              minY: Math.min(acc.minY, pos.y),
              maxY: Math.max(acc.maxY, pos.y),
            };
          }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
          
          const centerX = (bounds.minX + bounds.maxX) / 2;
          const centerY = (bounds.minY + bounds.maxY) / 2;
          const width = bounds.maxX - bounds.minX;
          const height = bounds.maxY - bounds.minY;
          const ratio = Math.max(width, height) / Math.min(sigma.getDimensions().width, sigma.getDimensions().height) * 1.2;
          
          sigma.getCamera().animate({
            x: centerX,
            y: centerY,
            ratio: ratio,
          }, {
            duration: 400,
          });
        }
      }
    });
  });
  
  // Filter by edge type
  document.querySelectorAll('[data-filter-edge]').forEach(el => {
    el.addEventListener('click', () => {
      const type = el.getAttribute('data-filter-edge');
      const nodesToShow = new Set();
      
      graph.forEachEdge((edge, attrs, source, target) => {
        if (attrs.type === type) {
          nodesToShow.add(source);
          nodesToShow.add(target);
        }
      });
      
      // Hide nodes not in filter
      graph.forEachNode((node) => {
        graph.setNodeAttribute(node, 'hidden', !nodesToShow.has(node));
      });
      
      sigma.refresh();
    });
  });
  
  // Reset filter on double-click
  document.addEventListener('dblclick', () => {
    if (!graph || !sigma) return;
    graph.forEachNode((node) => {
      graph.setNodeAttribute(node, 'hidden', false);
    });
    sigma.refresh();
  });
}
