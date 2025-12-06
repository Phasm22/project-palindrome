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
let currentTooltip = null;
let tooltipUpdateHandler = null;
let hoveredNode = null;
let originalNodeColor = null;

// Cleanup function to remove all tooltips
function cleanupAllTooltips() {
  // Remove any existing tooltips from DOM
  const existingTooltips = document.querySelectorAll('.graph-tooltip');
  existingTooltips.forEach(tooltip => tooltip.remove());
  
  // Reset state
  currentTooltip = null;
  tooltipUpdateHandler = null;
  hoveredNode = null;
  originalNodeColor = null;
}

export async function loadGraph() {
  const container = document.getElementById('graph-container');
  if (!container) return;
  
  // Cleanup any existing tooltips before loading new graph
  cleanupAllTooltips();
  
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
  
  // Show skeleton loader
  container.innerHTML = '';
  const loader = document.createElement('div');
  loader.className = 'flex flex-col items-center justify-center h-full gap-4';
  loader.innerHTML = `
    <div class="relative w-16 h-16">
      <div class="absolute inset-0 border-2 border-slate-700 rounded-full"></div>
      <div class="absolute inset-0 border-2 border-transparent border-t-primary-500 rounded-full"></div>
    </div>
    <div class="text-slate-400 text-sm">Loading graph...</div>
  `;
  container.appendChild(loader);
  
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
    // Graph is the constructor class from the exports
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
        nodeType: nodeType, // Use nodeType instead of type to avoid Sigma.js renderer selection
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
      const type = attrs.nodeType || attrs.type || 'unknown';
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
      <div class="flex flex-col md:flex-row gap-4">
        <!-- Graph Visualization -->
        <div class="flex-1 bg-slate-950 border border-slate-700 rounded-lg relative min-h-[400px] md:h-[600px] lg:h-[800px] overflow-hidden" style="position: relative;">
          <!-- Zoom Controls -->
          <div class="absolute top-4 right-4 z-10 flex flex-col gap-2">
            <button id="zoom-in" class="bg-gradient-to-br from-slate-800 to-slate-700 hover:from-slate-700 hover:to-slate-600 border-2 border-slate-600 hover:border-primary-500 text-slate-200 px-3 py-2 rounded-xl text-sm font-semibold transition-all duration-200 shadow-lg hover:shadow-xl hover:scale-110 active:scale-95" title="Zoom In">
              <span class="zoom-icon-in"></span>
            </button>
            <button id="zoom-out" class="bg-gradient-to-br from-slate-800 to-slate-700 hover:from-slate-700 hover:to-slate-600 border-2 border-slate-600 hover:border-primary-500 text-slate-200 px-3 py-2 rounded-xl text-sm font-semibold transition-all duration-200 shadow-lg hover:shadow-xl hover:scale-110 active:scale-95" title="Zoom Out">
              <span class="zoom-icon-out"></span>
            </button>
            <button id="zoom-fit" class="bg-gradient-to-br from-slate-800 to-slate-700 hover:from-slate-700 hover:to-slate-600 border-2 border-slate-600 hover:border-primary-500 text-slate-200 px-3 py-2 rounded-xl text-sm font-semibold transition-all duration-200 shadow-lg hover:shadow-xl hover:scale-110 active:scale-95" title="Fit to Screen">
              <span class="zoom-icon-fit"></span>
            </button>
            <button id="zoom-reset" class="bg-gradient-to-br from-slate-800 to-slate-700 hover:from-slate-700 hover:to-slate-600 border-2 border-slate-600 hover:border-primary-500 text-slate-200 px-3 py-2 rounded-xl text-sm font-semibold transition-all duration-200 shadow-lg hover:shadow-xl hover:scale-110 active:scale-95" title="Reset View">
              <span class="zoom-icon-reset"></span>
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
          
          <div id="sigma-container" style="position: absolute; inset: 0; width: 100%; height: 100%;"></div>
        </div>
        
        <!-- Statistics and Legend Sidebar -->
        <div class="w-full md:w-80 flex flex-col gap-4 overflow-y-auto">
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
    
    // Initialize Sigma after DOM is ready and measured
    const initGraph = async () => {
      // Wait for container to be measured
      await new Promise(resolve => {
        if (container.offsetWidth > 0 && container.offsetHeight > 0) {
          resolve();
        } else {
          requestAnimationFrame(resolve);
        }
      });
      
      // Initialize zoom control icons
      const { createIcon } = await import('./icons.js');
      document.querySelectorAll('.zoom-icon-in').forEach(el => {
        const icon = createIcon('ZoomIn', { size: 16, color: 'currentColor' });
        el.appendChild(icon);
      });
      document.querySelectorAll('.zoom-icon-out').forEach(el => {
        const icon = createIcon('ZoomOut', { size: 16, color: 'currentColor' });
        el.appendChild(icon);
      });
      document.querySelectorAll('.zoom-icon-fit').forEach(el => {
        const icon = createIcon('Maximize', { size: 16, color: 'currentColor' });
        el.appendChild(icon);
      });
      document.querySelectorAll('.zoom-icon-reset').forEach(el => {
        const icon = createIcon('RotateCcw', { size: 16, color: 'currentColor' });
        el.appendChild(icon);
      });
      
      initSigma();
      setupControls();
      setupSearch();
      setupFilters();
      
      // Set up ResizeObserver for container changes
      if (window.ResizeObserver && container) {
        const resizeObserver = new ResizeObserver(() => {
          if (sigma) {
            const dpr = window.devicePixelRatio || 1;
            sigma.setSetting('pixelRatio', dpr);
            sigma.refresh();
          }
        });
        resizeObserver.observe(container);
        // Store observer for cleanup
        window.graphResizeObserver = resizeObserver;
      }
      
      // Handle orientation changes
      window.addEventListener('orientationchange', () => {
        setTimeout(() => {
          if (sigma) {
            const dpr = window.devicePixelRatio || 1;
            sigma.setSetting('pixelRatio', dpr);
            sigma.refresh();
          }
        }, 100);
      });
      
      // Animate nodes in
      if (graph) {
        graph.forEachNode((node, attrs) => {
          const originalSize = attrs.size || 8;
          graph.setNodeAttribute(node, 'size', 0);
          sigma.refresh();
          
          setTimeout(() => {
            graph.setNodeAttribute(node, 'size', originalSize);
            sigma.refresh();
          }, Math.random() * 500);
        });
      }
    };
    
    // Use requestAnimationFrame for better timing
    requestAnimationFrame(() => {
      initGraph();
    });
  } catch (error) {
    container.innerHTML = 
      `<div class="error">Failed to load graph: ${error.message}</div>`;
  }
}

function initSigma() {
  const container = document.getElementById('sigma-container');
  if (!container || !graph) return;
  
  // Ensure container has proper dimensions before initializing
  const parent = container.parentElement;
  if (parent) {
    const rect = parent.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      console.warn('Graph container has zero dimensions, retrying...');
      setTimeout(() => initSigma(), 200);
      return;
    }
    // Force container to fill parent
    container.style.width = rect.width + 'px';
    container.style.height = rect.height + 'px';
  }
  
  // Destroy existing instance
  if (sigma) {
    sigma.kill();
    sigma = null;
  }
  
  // Remove 'type' attribute from nodes for Sigma.js (it's used for renderer selection)
  // We'll use 'nodeType' instead for our filtering, but keep 'type' in graph for compatibility
  graph.forEachNode((node, attrs) => {
    // Sigma.js v3 uses 'type' to select renderers, so we need to either:
    // 1. Not set 'type' on nodes (use default renderer)
    // 2. Register renderers for each type
    // We'll go with option 1 - remove 'type' from node attributes that Sigma sees
    // But keep it in the graph for our filtering logic
    if (attrs.type) {
      // Store the type in a different attribute that won't interfere with Sigma
      graph.setNodeAttribute(node, 'nodeType', attrs.type);
      // Remove 'type' so Sigma uses default renderer
      graph.removeNodeAttribute(node, 'type');
    }
  });
  
  // Get device pixel ratio for high-DPI displays
  const dpr = window.devicePixelRatio || 1;
  
  // Initialize Sigma with enhanced rendering and DPR awareness
  sigma = new Sigma(graph, container, {
    renderLabels: true,
    labelFont: 'Inter, system-ui, sans-serif',
    labelSize: 12,
    labelWeight: '600',
    labelColor: { attribute: 'color', defaultValue: colorPalette.text },
    defaultNodeColor: colorPalette.primary,
    defaultEdgeColor: colorPalette.primary,
    minCameraRatio: 0.1,
    maxCameraRatio: 10,
    allowInvalidContainer: true,
    pixelRatio: dpr,
    // Enhanced node rendering
    nodeReducer: (node, data) => {
      return {
        ...data,
        size: data.size || 8,
        color: data.color || colorPalette.primary,
        label: data.label || node,
      };
    },
    // Enhanced edge rendering
    edgeReducer: (edge, data) => {
      return {
        ...data,
        size: data.size || 2,
        color: data.color || colorPalette.primary,
        type: 'line',
      };
    },
  });
  
  // Add glow effect to nodes on hover
  let hoveredNode = null;
  let originalNodeColor = null;
  
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
  
  // Cleanup function for tooltips - removes all tooltips
  function cleanupTooltips() {
    // Remove all tooltips from DOM (in case multiple exist)
    const allTooltips = document.querySelectorAll('.graph-tooltip');
    allTooltips.forEach(tooltip => tooltip.remove());
    
    // Clean up current tooltip reference
    currentTooltip = null;
    
    // Remove event listeners
    if (tooltipUpdateHandler && container) {
      container.removeEventListener('mousemove', tooltipUpdateHandler);
      tooltipUpdateHandler = null;
    }
    
    // Restore node appearance
    if (hoveredNode && originalNodeColor && graph) {
      graph.setNodeAttribute(hoveredNode, 'color', originalNodeColor);
      const nodeData = graph.getNodeAttributes(hoveredNode);
      graph.setNodeAttribute(hoveredNode, 'size', (nodeData.size || 8) / 1.3);
      if (sigma) {
        sigma.refresh();
      }
      hoveredNode = null;
      originalNodeColor = null;
    }
  }
  
  // Cleanup tooltips when tab is hidden
  const graphTab = document.getElementById('graph');
  if (graphTab) {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          const isHidden = graphTab.classList.contains('hidden');
          if (isHidden) {
            cleanupTooltips();
          }
        }
      });
    });
    observer.observe(graphTab, { attributes: true, attributeFilter: ['class'] });
  }
  
  // Node hover tooltip with proper ARIA semantics
  sigma.on('enterNode', ({ node }) => {
    const nodeData = graph.getNodeAttributes(node);
    
    // Store original color and add glow
    if (hoveredNode !== node) {
      if (hoveredNode && originalNodeColor) {
        graph.setNodeAttribute(hoveredNode, 'color', originalNodeColor);
      }
      hoveredNode = node;
      originalNodeColor = nodeData.color;
      
      // Add glow effect by making node brighter and larger
      graph.setNodeAttribute(node, 'color', colorPalette.warning);
      graph.setNodeAttribute(node, 'size', (nodeData.size || 8) * 1.3);
      sigma.refresh();
    }
    
    // Remove existing tooltip if any
    if (currentTooltip) {
      currentTooltip.remove();
      if (tooltipUpdateHandler) {
        container.removeEventListener('mousemove', tooltipUpdateHandler);
      }
    }
    
    // Create tooltip with proper ARIA attributes
    const tooltip = document.createElement('div');
    tooltip.className = 'graph-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.setAttribute('aria-live', 'polite');
    tooltip.setAttribute('id', `tooltip-${node}`);
    tooltip.style.cssText = `
      position: absolute;
      background: linear-gradient(135deg, ${colorPalette.surface} 0%, #1e293b 100%);
      color: ${colorPalette.text};
      padding: 12px 16px;
      border-radius: 12px;
      border: 2px solid ${colorPalette.primary};
      font-size: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      z-index: 1000;
      pointer-events: none;
      box-shadow: 0 8px 16px rgba(0, 0, 0, 0.4), 0 0 20px rgba(249, 115, 22, 0.3);
      max-width: 300px;
      animation: slide-up-fade 0.2s ease-out;
    `;
    
    // Build accessible tooltip content
    const label = nodeData.label || node;
    let tooltipContent = `<strong style="color: ${colorPalette.primary}; font-size: 14px;">${label}</strong><br>`;
    tooltipContent += `<span style="color: ${colorPalette.textMuted}">Type:</span> <span style="color: ${colorPalette.text}">${nodeData.type || 'unknown'}</span><br>`;
    tooltipContent += `<span style="color: ${colorPalette.textMuted}">Degree:</span> <span style="color: ${colorPalette.text}">${nodeData.degree || 0}</span><br>`;
    if (nodeData.id) tooltipContent += `<span style="color: ${colorPalette.textMuted}">ID:</span> <span style="color: ${colorPalette.text}">${nodeData.id}</span><br>`;
    if (nodeData.purpose) tooltipContent += `<span style="color: ${colorPalette.textMuted}">Purpose:</span> <span style="color: ${colorPalette.text}">${nodeData.purpose}</span><br>`;
    if (nodeData.role) tooltipContent += `<span style="color: ${colorPalette.textMuted}">Role:</span> <span style="color: ${colorPalette.text}">${nodeData.role}</span><br>`;
    
    tooltip.innerHTML = tooltipContent;
    document.body.appendChild(tooltip);
    currentTooltip = tooltip;
    
    // Update tooltip position on mouse move
    tooltipUpdateHandler = (e) => {
      const padding = 10;
      const tooltipRect = tooltip.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      let left = e.clientX + padding;
      let top = e.clientY + padding;
      
      // Prevent tooltip from going off-screen
      if (left + tooltipRect.width > viewportWidth) {
        left = e.clientX - tooltipRect.width - padding;
      }
      if (top + tooltipRect.height > viewportHeight) {
        top = e.clientY - tooltipRect.height - padding;
      }
      
      tooltip.style.left = `${Math.max(padding, left)}px`;
      tooltip.style.top = `${Math.max(padding, top)}px`;
    };
    
    // Set initial position based on node position
    const nodePosition = sigma.getNodeDisplayData(node);
    const camera = sigma.getCamera();
    // Get viewport dimensions from container instead of getViewport() (not available in this Sigma version)
    const containerRect = container.getBoundingClientRect();
    const viewportWidth = containerRect.width;
    const viewportHeight = containerRect.height;
    const x = nodePosition.x * camera.ratio + viewportWidth / 2 + camera.x;
    const y = nodePosition.y * camera.ratio + viewportHeight / 2 + camera.y;
    
    tooltip.style.left = `${containerRect.left + x + 10}px`;
    tooltip.style.top = `${containerRect.top + y + 10}px`;
    
    container.addEventListener('mousemove', tooltipUpdateHandler);
    
    sigma.once('leaveNode', () => {
      cleanupTooltips();
    });
  });
  
  // Node click to center with pulse animation
  sigma.on('clickNode', ({ node }) => {
    const nodeData = graph.getNodeAttributes(node);
    const originalSize = nodeData.size || 8;
    
    // Pulse animation
    graph.setNodeAttribute(node, 'size', originalSize * 1.5);
    sigma.refresh();
    
    setTimeout(() => {
      graph.setNodeAttribute(node, 'size', originalSize * 1.2);
      sigma.refresh();
      
      setTimeout(() => {
        graph.setNodeAttribute(node, 'size', originalSize);
        sigma.refresh();
      }, 150);
    }, 150);
    
    const nodePosition = sigma.getNodeDisplayData(node);
    sigma.getCamera().animate({
      x: nodePosition.x,
      y: nodePosition.y,
      ratio: Math.min(sigma.getCamera().ratio * 0.7, 2),
    }, {
      duration: 400,
      easing: 'quadraticOut',
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
        const nodeType = attrs.nodeType || attrs.type;
        if (nodeType === type) {
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
