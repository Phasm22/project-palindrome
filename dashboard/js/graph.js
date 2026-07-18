import { API_URL, escapeHtml } from './utils.js';

// Color palette - burnt orange theme with soft, distinct colors
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

// Node type colors - soft, distinct colors that contrast with dark background (#0f172a)
const nodeTypeColors = {
  'compute_vm': '#60a5fa',        // Soft blue - VMs
  'compute_node': '#34d399',      // Soft green - Physical nodes
  'network_interface': '#a78bfa', // Soft purple - Network interfaces
  'network_subnet': '#c084fc',    // Light purple - Subnets
  'storage': '#f87171',           // Soft red - Storage
  'firewall_rule': '#fbbf24',     // Soft yellow - Firewall rules
  'entity': '#fb923c',            // Soft orange - Generic entities
  'twinentity': '#f472b6',        // Soft pink - Twin entities
  'unknown': '#94a3b8',           // Gray - Unknown
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
      // Normalize type - prioritize entityType, then type, then labels
      const rawType = n.entityType || n.type || n.labels?.[0] || 'unknown';
      const nodeType = String(rawType).toLowerCase();
      const degree = nodeDegrees[nodeId] || 0;
      const size = Math.max(8, Math.min(30, 8 + (degree / maxDegree) * 22)); // Size by degree: 8-30px
      
      const color = nodeTypeColors[nodeType] || nodeTypeColors['unknown'];
      
      // Use displayName or name for label
      const label = n.displayName || n.name || n.properties?.displayName || n.properties?.name || nodeId || 'Unknown';
      
      graph.addNode(nodeId, {
        label: label,
        size: size,
        color: color,
        nodeType: nodeType, // Normalized lowercase type for filtering
        entityType: nodeType, // Also store as entityType for consistency
        degree: degree,
        x: Math.random() * 1000,
        y: Math.random() * 1000,
        // Store all node data for tooltip
        ...n,
        ...n.properties,
      });
    });
    
    // Edge type colors for better distinction
    const edgeTypeColors = {
      'RUNS_ON': '#60a5fa',      // Blue
      'CONNECTS_TO': '#a78bfa',  // Purple
      'ATTACHED_TO': '#34d399',  // Green
      'CONFIGURED_BY': '#fbbf24', // Yellow
      'OWNS': '#f472b6',         // Pink
      'HOSTS_ON': '#fb923c',     // Orange
      'AFFECTS': '#f87171',      // Red
      'ROUTES_TO': '#c084fc',    // Light purple
      'EXPOSES': '#fcd34d',      // Light yellow
      'REACHABLE': '#86efac',    // Light green
    };
    
    // Add edges
    data.relationships.forEach(r => {
      const from = r.from || r.start;
      const to = r.to || r.end;
      if (graph.hasNode(from) && graph.hasNode(to)) {
        try {
          const edgeType = r.type || 'unknown';
          const edgeColor = edgeTypeColors[edgeType] || colorPalette.textMuted;
          graph.addEdge(from, to, {
            label: edgeType,
            type: edgeType,
            color: edgeColor,
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
      // Get the actual entity type (prioritize entityType, then nodeType, then type)
      const type = (attrs.entityType || attrs.nodeType || attrs.type || 'unknown').toLowerCase();
      nodeTypes[type] = (nodeTypes[type] || 0) + 1;
    });
    graph.forEachEdge((edge, attrs) => {
      const type = attrs.type || attrs.label || 'unknown';
      if (type && type !== 'unknown' && type !== '') {
        edgeTypes[type] = (edgeTypes[type] || 0) + 1;
      }
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
            <button id="zoom-in" class="quiet-icon-action" title="Zoom In">
              <span class="zoom-icon-in"></span>
            </button>
            <button id="zoom-out" class="quiet-icon-action" title="Zoom Out">
              <span class="zoom-icon-out"></span>
            </button>
            <button id="zoom-fit" class="quiet-icon-action" title="Fit to Screen">
              <span class="zoom-icon-fit"></span>
            </button>
            <button id="zoom-reset" class="quiet-icon-action" title="Reset View">
              <span class="zoom-icon-reset"></span>
            </button>
          </div>
          
          <!-- Search Box -->
          <div class="absolute top-4 left-4 z-10 w-64">
            <input 
              type="text" 
              id="node-search" 
              placeholder="Search nodes..." 
              class="w-full px-4 py-2.5 bg-slate-700/30 backdrop-blur-lg border border-slate-400/40 rounded-xl text-slate-100 placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500/60 focus:border-primary-500/80 shadow-xl transition-all"
              style="box-shadow: inset 0 2px 4px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.1), 0 4px 16px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05); background: linear-gradient(135deg, rgba(51,65,85,0.4) 0%, rgba(30,41,59,0.5) 100%);"
            />
            <div id="search-results" class="mt-2 bg-slate-700/30 backdrop-blur-lg border border-slate-400/40 rounded-xl max-h-48 overflow-y-auto hidden shadow-xl" style="box-shadow: 0 4px 16px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.1); background: linear-gradient(135deg, rgba(51,65,85,0.4) 0%, rgba(30,41,59,0.5) 100%);"></div>
          </div>
          
          <div id="sigma-container" style="position: absolute; inset: 0; width: 100%; height: 100%;"></div>
        </div>
        
        <!-- Statistics and Legend Sidebar -->
        <div class="w-full md:w-80 flex flex-col gap-4 overflow-y-auto">
          <!-- Statistics Panel -->
          <div class="bg-slate-950/90 border-2 border-slate-500 rounded-xl p-4 shadow-sm">
            <h3 class="m-0 mb-4 text-slate-200 text-base font-semibold">Statistics</h3>
            <div class="grid grid-cols-2 gap-4 mb-4">
              <div class="p-4 bg-slate-900/90 border-2 border-slate-500 rounded-xl text-center shadow-sm">
                <div class="text-slate-400 text-xs mb-1">Total Nodes</div>
                <div class="text-slate-100 text-2xl font-bold">${totalNodes}</div>
              </div>
              <div class="p-4 bg-slate-900/90 border-2 border-slate-500 rounded-xl text-center shadow-sm">
                <div class="text-slate-400 text-xs mb-1">Total Edges</div>
                <div class="text-slate-100 text-2xl font-bold">${totalEdges}</div>
              </div>
              <div class="p-4 bg-slate-900/90 border-2 border-slate-500 rounded-xl text-center shadow-sm">
                <div class="text-slate-400 text-xs mb-1">Node Types</div>
                <div class="text-slate-100 text-2xl font-bold">${uniqueNodeTypes}</div>
              </div>
              <div class="p-4 bg-slate-900/90 border-2 border-slate-500 rounded-xl text-center shadow-sm">
                <div class="text-slate-400 text-xs mb-1">Edge Types</div>
                <div class="text-slate-100 text-2xl font-bold">${uniqueEdgeTypes}</div>
              </div>
            </div>
          </div>
          
          <!-- Node Types Legend -->
          <details class="bg-slate-950/90 border-2 border-slate-500 rounded-xl p-4 shadow-sm" open>
            <summary class="cursor-pointer text-slate-200 font-semibold mb-3 text-base">Node Types</summary>
            <div class="flex flex-col gap-2">
              ${Object.entries(nodeTypes).sort((a, b) => b[1] - a[1]).map(([type, count]) => {
                const color = nodeTypeColors[type] || nodeTypeColors['unknown'];
                // Format type for display (replace underscores, capitalize)
                const displayType = type.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
                return `
                <div class="flex items-center gap-3 p-2 bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer" data-filter-type="${escapeHtml(type)}">
                  <div class="w-4 h-4 rounded-full" style="background: ${color}; border: 2px solid #334155;"></div>
                  <div class="flex-1 text-slate-200 text-sm">${escapeHtml(displayType)}</div>
                  <div class="text-slate-400 text-xs font-semibold">${escapeHtml(String(count))}</div>
                </div>
              `;
              }).join('')}
            </div>
          </details>
          
          ${uniqueEdgeTypes > 0 ? `
          <!-- Edge Types Legend -->
          <details class="bg-slate-950/90 border-2 border-slate-500 rounded-xl p-4 shadow-sm">
            <summary class="cursor-pointer text-slate-200 font-semibold mb-3 text-base">Relationship Types</summary>
            <div class="flex flex-col gap-2">
              ${Object.entries(edgeTypes).sort((a, b) => b[1] - a[1]).map(([type, count]) => `
                <div class="flex items-center gap-3 p-2 bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer" data-filter-edge="${escapeHtml(type)}">
                  <div class="w-5 h-0.5" style="background: ${colorPalette.primary};"></div>
                  <div class="flex-1 text-slate-200 text-sm">${escapeHtml(type || 'unnamed')}</div>
                  <div class="text-slate-400 text-xs font-semibold">${escapeHtml(String(count))}</div>
                </div>
              `).join('')}
            </div>
          </details>
          ` : ''}
          
          <!-- Info Panel -->
          <details class="bg-slate-950/90 border-2 border-slate-500 rounded-xl p-4 shadow-sm">
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
      
      // Initialize zoom control icons - clear existing first to prevent duplicates
      const { createIcon } = await import('./icons.js');
      
      // Clear existing icons before adding new ones (prevents duplicates on reload)
      document.querySelectorAll('.zoom-icon-in, .zoom-icon-out, .zoom-icon-fit, .zoom-icon-reset').forEach(el => {
        // Remove all SVG children (icons)
        Array.from(el.children).forEach(child => {
          if (child.tagName === 'svg') {
            child.remove();
          }
        });
      });
      
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
      // Keep ontology type (compute_vm, network_interface, ...) for filtering.
      // Do not replace it with generic Neo4j labels such as "TwinEntity".
      const normalizedEntityType = (attrs.entityType || attrs.nodeType || attrs.type || 'unknown')
        .toString()
        .toLowerCase();
      graph.setNodeAttribute(node, 'entityType', normalizedEntityType);
      graph.setNodeAttribute(node, 'nodeType', normalizedEntityType);
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
      z-index: var(--z-tooltip);
      pointer-events: none;
      box-shadow: 0 8px 16px rgba(0, 0, 0, 0.4), 0 0 20px rgba(249, 115, 22, 0.3);
      max-width: 300px;
      animation: slide-up-fade 0.2s ease-out;
    `;
    
    // Build accessible tooltip content with meaningful data
    const label = nodeData.label || nodeData.displayName || node;
    const entityType = nodeData.entityType || nodeData.type || nodeData.nodeType || 'unknown';
    const tooltipValue = (value) => escapeHtml(String(value));
    
    let tooltipContent = `<strong style="color: ${colorPalette.primary}; font-size: 14px;">${tooltipValue(label)}</strong><br>`;
    
    // Show meaningful data based on entity type
    if (entityType === 'compute_node') {
      if (nodeData.status) tooltipContent += `<span style="color: ${colorPalette.textMuted}">Status:</span> <span style="color: ${nodeData.status === 'online' ? colorPalette.success : colorPalette.error}">${tooltipValue(nodeData.status)}</span><br>`;
      if (nodeData.data?.cpuTotalCores) tooltipContent += `<span style="color: ${colorPalette.textMuted}">CPU Cores:</span> <span style="color: ${colorPalette.text}">${tooltipValue(nodeData.data.cpuTotalCores)}</span><br>`;
      if (nodeData.data?.memoryTotalBytes) {
        const memGB = (nodeData.data.memoryTotalBytes / (1024 ** 3)).toFixed(1);
        tooltipContent += `<span style="color: ${colorPalette.textMuted}">Memory:</span> <span style="color: ${colorPalette.text}">${memGB} GB</span><br>`;
      }
    } else if (entityType === 'compute_vm') {
      if (nodeData.state) tooltipContent += `<span style="color: ${colorPalette.textMuted}">State:</span> <span style="color: ${nodeData.state === 'running' ? colorPalette.success : colorPalette.error}">${tooltipValue(nodeData.state)}</span><br>`;
      if (nodeData.nodeName) tooltipContent += `<span style="color: ${colorPalette.textMuted}">Node:</span> <span style="color: ${colorPalette.text}">${tooltipValue(nodeData.nodeName)}</span><br>`;
      if (nodeData.vmKind) tooltipContent += `<span style="color: ${colorPalette.textMuted}">Kind:</span> <span style="color: ${colorPalette.text}">${tooltipValue(nodeData.vmKind.toUpperCase())}</span><br>`;
      if (nodeData.data?.agentAvailable !== undefined) {
        tooltipContent += `<span style="color: ${colorPalette.textMuted}">Agent:</span> <span style="color: ${nodeData.data.agentAvailable ? colorPalette.success : colorPalette.warning}">${nodeData.data.agentAvailable ? 'Available' : 'Missing'}</span><br>`;
      }
    } else if (entityType === 'network_interface') {
      if (nodeData.nodeName) tooltipContent += `<span style="color: ${colorPalette.textMuted}">Node:</span> <span style="color: ${colorPalette.text}">${tooltipValue(nodeData.nodeName)}</span><br>`;
      if (nodeData.primaryIp) tooltipContent += `<span style="color: ${colorPalette.textMuted}">IP:</span> <span style="color: ${colorPalette.text}">${tooltipValue(nodeData.primaryIp)}</span><br>`;
      if (nodeData.data?.vlan) tooltipContent += `<span style="color: ${colorPalette.textMuted}">VLAN:</span> <span style="color: ${colorPalette.text}">${tooltipValue(nodeData.data.vlan)}</span><br>`;
    } else if (entityType === 'network_subnet') {
      if (nodeData.cidr) tooltipContent += `<span style="color: ${colorPalette.textMuted}">CIDR:</span> <span style="color: ${colorPalette.text}">${tooltipValue(nodeData.cidr)}</span><br>`;
      if (nodeData.gateway) tooltipContent += `<span style="color: ${colorPalette.textMuted}">Gateway:</span> <span style="color: ${colorPalette.text}">${tooltipValue(nodeData.gateway)}</span><br>`;
    } else if (entityType === 'firewall_rule') {
      if (nodeData.action) tooltipContent += `<span style="color: ${colorPalette.textMuted}">Action:</span> <span style="color: ${nodeData.action === 'pass' ? colorPalette.success : colorPalette.error}">${tooltipValue(nodeData.action)}</span><br>`;
      if (nodeData.source) tooltipContent += `<span style="color: ${colorPalette.textMuted}">Source:</span> <span style="color: ${colorPalette.text}">${tooltipValue(nodeData.source)}</span><br>`;
      if (nodeData.destination) tooltipContent += `<span style="color: ${colorPalette.textMuted}">Destination:</span> <span style="color: ${colorPalette.text}">${tooltipValue(nodeData.destination)}</span><br>`;
      if (nodeData.protocol) tooltipContent += `<span style="color: ${colorPalette.textMuted}">Protocol:</span> <span style="color: ${colorPalette.text}">${tooltipValue(nodeData.protocol.toUpperCase())}</span><br>`;
    } else if (entityType === 'storage') {
      if (nodeData.nodeName) tooltipContent += `<span style="color: ${colorPalette.textMuted}">Node:</span> <span style="color: ${colorPalette.text}">${tooltipValue(nodeData.nodeName)}</span><br>`;
      if (nodeData.data?.storageType) tooltipContent += `<span style="color: ${colorPalette.textMuted}">Type:</span> <span style="color: ${colorPalette.text}">${tooltipValue(nodeData.data.storageType)}</span><br>`;
      if (nodeData.data?.totalBytes) {
        const totalGB = (nodeData.data.totalBytes / (1024 ** 3)).toFixed(1);
        const usedGB = nodeData.data.usedBytes ? (nodeData.data.usedBytes / (1024 ** 3)).toFixed(1) : '0';
        tooltipContent += `<span style="color: ${colorPalette.textMuted}">Storage:</span> <span style="color: ${colorPalette.text}">${usedGB} / ${totalGB} GB</span><br>`;
      }
    } else {
      // Fallback for other node types - show type but not degree
      tooltipContent += `<span style="color: ${colorPalette.textMuted}">Type:</span> <span style="color: ${colorPalette.text}">${tooltipValue(entityType)}</span><br>`;
    }
    
    // Always show ID for reference
    if (nodeData.id) tooltipContent += `<span style="color: ${colorPalette.textMuted}">ID:</span> <span style="color: ${colorPalette.text}; font-size: 10px;">${tooltipValue(nodeData.id)}</span><br>`;
    
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
    
    if (typeof nodeData.x === 'number' && typeof nodeData.y === 'number') {
      sigma.getCamera().animate({
        x: nodeData.x,
        y: nodeData.y,
        ratio: Math.min(sigma.getCamera().ratio * 0.7, 2),
      }, {
        duration: 400,
        easing: 'quadraticOut',
      });
    }
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
        const nodeAttrs = graph.getNodeAttributes(node);
        const typeKey = (nodeAttrs.entityType || nodeAttrs.nodeType || nodeAttrs.type || 'unknown').toLowerCase();
        graph.setNodeAttribute(node, 'color', graph.getNodeAttribute(node, 'originalColor') || nodeTypeColors[typeKey] || nodeTypeColors['unknown']);
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
        const type = (attrs.entityType || attrs.nodeType || attrs.type || '').toLowerCase();
        if (label.includes(query) || id.includes(query) || type.includes(query)) {
          matchingNodes.push({ node, attrs });
        }
      });
      
      // Reset previous highlights
      highlightedNodes.forEach(node => {
        graph.setNodeAttribute(node, 'highlighted', false);
        const nodeAttrs = graph.getNodeAttributes(node);
        const typeKey = (nodeAttrs.entityType || nodeAttrs.nodeType || nodeAttrs.type || 'unknown').toLowerCase();
        graph.setNodeAttribute(node, 'color', graph.getNodeAttribute(node, 'originalColor') || nodeTypeColors[typeKey] || nodeTypeColors['unknown']);
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
              <div class="text-xs text-slate-400">${attrs.entityType || attrs.nodeType || attrs.type || 'unknown'}</div>
            </div>
          `;
        }).join('');
        resultsDiv.classList.remove('hidden');
        
        // Click handler for results
        resultsDiv.querySelectorAll('[data-node-id]').forEach(el => {
          el.addEventListener('click', () => {
            const nodeId = el.getAttribute('data-node-id');
            const nodeAttrs = nodeId ? graph.getNodeAttributes(nodeId) : null;
            if (nodeAttrs && typeof nodeAttrs.x === 'number' && typeof nodeAttrs.y === 'number') {
              sigma.getCamera().animate({
                x: nodeAttrs.x,
                y: nodeAttrs.y,
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
  let activeNodeTypeFilter = null;
  let activeEdgeTypeFilter = null;
  const autoFitAfterFilter = () => {
    // Mirror the "focus" button behavior so filtered graphs are immediately visible.
    requestAnimationFrame(() => {
      sigma.getCamera().animatedReset({ duration: 300 });
    });
  };

  const clearFilterStyles = () => {
    document.querySelectorAll('[data-filter-type], [data-filter-edge]').forEach((item) => {
      if (!(item instanceof HTMLElement)) return;
      item.style.outline = '';
      item.style.background = '';
    });
  };

  const markActiveFilter = (el) => {
    clearFilterStyles();
    if (el instanceof HTMLElement) {
      el.style.outline = '2px solid #f97316';
      el.style.background = 'rgba(249, 115, 22, 0.12)';
    }
  };

  const resetVisibility = () => {
    graph.forEachNode((node) => {
      graph.setNodeAttribute(node, 'hidden', false);
    });
    graph.forEachEdge((edge) => {
      graph.setEdgeAttribute(edge, 'hidden', false);
    });
    activeNodeTypeFilter = null;
    activeEdgeTypeFilter = null;
    clearFilterStyles();
    sigma.refresh();
  };

  const applyNodeTypeVisibility = (nodesToShow) => {
    graph.forEachNode((node) => {
      graph.setNodeAttribute(node, 'hidden', !nodesToShow.has(node));
    });
    graph.forEachEdge((edge, _attrs, source, target) => {
      graph.setEdgeAttribute(edge, 'hidden', !(nodesToShow.has(source) && nodesToShow.has(target)));
    });
    sigma.refresh();
  };

  const applyEdgeTypeVisibility = (edgeType) => {
    const nodesToShow = new Set();

    // First pass: mark edges that match the selected type and collect incident nodes.
    graph.forEachEdge((edge, attrs, source, target) => {
      const relType = (attrs?.type || attrs?.label || '').toString();
      const matches = relType.toLowerCase() === edgeType.toLowerCase();
      graph.setEdgeAttribute(edge, 'hidden', !matches);
      if (matches) {
        nodesToShow.add(source);
        nodesToShow.add(target);
      }
    });

    // Second pass: only show nodes that participate in matching edges.
    graph.forEachNode((node) => {
      graph.setNodeAttribute(node, 'hidden', !nodesToShow.has(node));
    });

    sigma.refresh();
    return nodesToShow;
  };

  const focusVisibleNodes = (nodesToShow) => {
    const positions = [];
    nodesToShow.forEach((node) => {
      const attrs = graph.getNodeAttributes(node);
      if (typeof attrs?.x === 'number' && typeof attrs?.y === 'number') {
        positions.push({ x: attrs.x, y: attrs.y });
      }
    });

    if (!positions.length) {
      return;
    }

    const bounds = positions.reduce((acc, pos) => ({
      minX: Math.min(acc.minX, pos.x),
      maxX: Math.max(acc.maxX, pos.x),
      minY: Math.min(acc.minY, pos.y),
      maxY: Math.max(acc.maxY, pos.y),
    }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });

    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const dims = sigma.getDimensions();
    const targetRatio = Math.max(width / Math.max(1, dims.width), height / Math.max(1, dims.height)) * 1.8;
    const ratio = Number.isFinite(targetRatio) && targetRatio > 0
      ? Math.min(10, Math.max(0.1, targetRatio))
      : sigma.getCamera().ratio;

    sigma.getCamera().animate({
      x: centerX,
      y: centerY,
      ratio,
    }, {
      duration: 400,
    });
  };
  
  // Filter by node type
  document.querySelectorAll('[data-filter-type]').forEach(el => {
    el.addEventListener('click', () => {
      const filterType = el.getAttribute('data-filter-type');
      if (!filterType) return;

      // Toggle current node-type filter off
      if (activeNodeTypeFilter === filterType) {
        resetVisibility();
        return;
      }
      
      const nodesToShow = new Set();
      
      graph.forEachNode((node, attrs) => {
        // Check all possible type attributes (nodeType, entityType, type)
        // Normalize both to lowercase with underscores for comparison
        const nodeType = (attrs.entityType || attrs.nodeType || attrs.type || '').toLowerCase().replace(/[-\s]/g, '_');
        const targetType = filterType.toLowerCase().replace(/[-\s]/g, '_');
        
        if (nodeType === targetType) {
          nodesToShow.add(node);
          // Add connected nodes for context
          graph.forEachNeighbor(node, neighbor => {
            nodesToShow.add(neighbor);
          });
        }
      });

      if (!nodesToShow.size) {
        // Never leave the graph fully hidden.
        resetVisibility();
        return;
      }

      activeEdgeTypeFilter = null;
      activeNodeTypeFilter = filterType;
      markActiveFilter(el);
      applyNodeTypeVisibility(nodesToShow);
      focusVisibleNodes(nodesToShow);
      autoFitAfterFilter();
    });
  });
  
  // Filter by edge type
  document.querySelectorAll('[data-filter-edge]').forEach(el => {
    el.addEventListener('click', () => {
      const type = el.getAttribute('data-filter-edge');
      if (!type) return;

      // Toggle current edge filter off
      if (activeEdgeTypeFilter === type) {
        resetVisibility();
        return;
      }

      const nodesToShow = applyEdgeTypeVisibility(type);

      if (!nodesToShow.size) {
        resetVisibility();
        return;
      }

      activeNodeTypeFilter = null;
      activeEdgeTypeFilter = type;
      markActiveFilter(el);
      focusVisibleNodes(nodesToShow);
      autoFitAfterFilter();
    });
  });
  
  // Reset filter on double-click
  document.addEventListener('dblclick', () => {
    if (!graph || !sigma) return;
    resetVisibility();
  });
}
