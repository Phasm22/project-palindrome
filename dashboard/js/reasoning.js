import { API_URL } from './utils.js';
import { addTooltip, createModal } from './ui-helpers.js';
import { createSkeletonLoader } from './skeletons.js';

// Format tool results for readable display
function formatToolResult(dataPreview, toolName) {
  if (!dataPreview) return '';
  
  try {
    // Try to parse as JSON
    const data = typeof dataPreview === 'string' ? JSON.parse(dataPreview) : dataPreview;
    
    // Handle Proxmox VM list
    if (data.vms && Array.isArray(data.vms)) {
      return `
        <div style="font-size: 0.8rem;">
          <div style="color: #10b981; margin-bottom: 8px; font-weight: 600;">
            📦 ${data.vms.length} VM${data.vms.length !== 1 ? 's' : ''} found
          </div>
          <div style="display: grid; gap: 6px;">
            ${data.vms.slice(0, 10).map(vm => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #1e293b; border-radius: 4px;">
                <span style="width: 8px; height: 8px; border-radius: 50%; background: ${vm.status === 'running' ? '#10b981' : '#94a3b8'};"></span>
                <span style="color: #f97316; font-weight: 500; min-width: 120px;">${vm.name || vm.vmid}</span>
                <span style="color: #94a3b8; font-size: 0.75rem;">ID: ${vm.vmid}</span>
                <span style="color: #94a3b8; font-size: 0.75rem;">${vm.node || ''}</span>
                ${vm.mem_normalized ? `<span style="color: #8b5cf6; font-size: 0.75rem;">${vm.mem_normalized.value}${vm.mem_normalized.unit}</span>` : ''}
              </div>
            `).join('')}
            ${data.vms.length > 10 ? `<div style="color: #94a3b8; font-size: 0.75rem;">... and ${data.vms.length - 10} more</div>` : ''}
          </div>
        </div>
      `;
    }
    
    // Handle containers
    if (data.containers && Array.isArray(data.containers)) {
      return `
        <div style="font-size: 0.8rem;">
          <div style="color: #10b981; margin-bottom: 8px; font-weight: 600;">
            🐳 ${data.containers.length} container${data.containers.length !== 1 ? 's' : ''} found
          </div>
          <div style="display: grid; gap: 6px;">
            ${data.containers.slice(0, 10).map(ct => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #1e293b; border-radius: 4px;">
                <span style="width: 8px; height: 8px; border-radius: 50%; background: ${ct.status === 'running' ? '#10b981' : '#94a3b8'};"></span>
                <span style="color: #f97316; font-weight: 500;">${ct.name || ct.vmid}</span>
                <span style="color: #94a3b8; font-size: 0.75rem;">ID: ${ct.vmid}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }
    
    // Handle nodes
    if (data.nodes && Array.isArray(data.nodes)) {
      return `
        <div style="font-size: 0.8rem;">
          <div style="color: #10b981; margin-bottom: 8px; font-weight: 600;">
            🖥️ ${data.nodes.length} node${data.nodes.length !== 1 ? 's' : ''} found
          </div>
          <div style="display: grid; gap: 6px;">
            ${data.nodes.map(node => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #1e293b; border-radius: 4px;">
                <span style="width: 8px; height: 8px; border-radius: 50%; background: ${node.status === 'online' ? '#10b981' : '#ef4444'};"></span>
                <span style="color: #f97316; font-weight: 500;">${node.node}</span>
                <span style="color: #94a3b8; font-size: 0.75rem;">${node.status}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }
    
    // Handle graph/twin query results
    if (data.entities && Array.isArray(data.entities)) {
      return `
        <div style="font-size: 0.8rem;">
          <div style="color: #8b5cf6; margin-bottom: 8px; font-weight: 600;">
            🔗 ${data.entities.length} entit${data.entities.length !== 1 ? 'ies' : 'y'} found
          </div>
          <div style="display: grid; gap: 6px;">
            ${data.entities.slice(0, 8).map(e => `
              <div style="padding: 6px 8px; background: #1e293b; border-radius: 4px; display: flex; gap: 8px; align-items: center;">
                <span style="background: #8b5cf6; color: white; padding: 2px 6px; border-radius: 3px; font-size: 0.7rem;">${e.type || e.labels?.[0] || 'Entity'}</span>
                <span style="color: #e2e8f0;">${e.name || e.properties?.name || e.id || 'Unknown'}</span>
              </div>
            `).join('')}
            ${data.entities.length > 8 ? `<div style="color: #94a3b8; font-size: 0.75rem;">... and ${data.entities.length - 8} more</div>` : ''}
          </div>
        </div>
      `;
    }
    
    // Handle simple success/error responses
    if (data.success !== undefined) {
      return `
        <div style="display: flex; align-items: center; gap: 8px; color: ${data.success ? '#10b981' : '#ef4444'};">
          ${data.success ? '✅' : '❌'} ${data.message || (data.success ? 'Operation successful' : 'Operation failed')}
        </div>
      `;
    }
    
    // Default: pretty print JSON with truncation
    const jsonStr = JSON.stringify(data, null, 2);
    if (jsonStr.length > 500) {
      return `<pre style="background: #0f172a; padding: 8px; border-radius: 4px; font-size: 0.7rem; overflow-x: auto; margin: 0; max-height: 150px; overflow-y: auto;">${jsonStr.substring(0, 500)}...\n<span style="color: #94a3b8;">[${jsonStr.length - 500} more chars]</span></pre>`;
    }
    return `<pre style="background: #0f172a; padding: 8px; border-radius: 4px; font-size: 0.7rem; overflow-x: auto; margin: 0;">${jsonStr}</pre>`;
  } catch (error) {
    // If parsing fails, return as-is
    return `<pre style="background: #0f172a; padding: 8px; border-radius: 4px; font-size: 0.7rem; overflow-x: auto; margin: 0;">${typeof dataPreview === 'string' ? dataPreview : JSON.stringify(dataPreview)}</pre>`;
  }
}

function formatFinalResponse(text) {
  if (!text) return '';
  
  let formatted = text;
  
  // Format code blocks
  formatted = formatted.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    return `<pre style="background: #0f172a; padding: 12px; border-radius: 6px; overflow-x: auto; margin: 10px 0; border: 1px solid #334155;"><code>${code.trim()}</code></pre>`;
  });
  
  // Format inline code
  formatted = formatted.replace(/`([^`]+)`/g, '<code style="background: #1e293b; padding: 2px 6px; border-radius: 3px; font-family: monospace; font-size: 0.9em;">$1</code>');
  
  // Format bold
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong style="color: #e2e8f0;">$1</strong>');
  
  // Format lists
  formatted = formatted.replace(/^(\d+)\.\s+(.+)$/gm, '<li style="margin-left: 20px; margin-bottom: 4px;">$2</li>');
  formatted = formatted.replace(/^[-*]\s+(.+)$/gm, '<li style="margin-left: 20px; margin-bottom: 4px;">$1</li>');
  
  // Wrap consecutive list items
  formatted = formatted.replace(/(<li[^>]*>.*<\/li>\n?)+/g, '<ul style="margin: 10px 0; padding-left: 20px;">$&</ul>');
  
  // Format line breaks
  formatted = formatted.replace(/\n/g, '<br>');
  
  return formatted;
}

/**
 * Copy full trace data to clipboard, formatted for debugging
 */
export async function copyTraceData(traceId, buttonElement) {
  try {
    // Show loading state
    const originalBg = buttonElement.style.background;
    buttonElement.style.background = '#f59e0b';
    buttonElement.disabled = true;
    
    // Fetch full trace data
    const response = await fetch(`${API_URL}/api/dashboard/reasoning-traces/${traceId}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const traceData = await response.json();
    
    // Format trace data for debugging (pretty JSON with metadata header)
    const formattedTrace = `=== Reasoning Trace: ${traceId} ===
Timestamp: ${new Date(traceData.timestamp).toISOString()}
User: ${traceData.userId} (ACL: ${traceData.aclGroup})
Duration: ${traceData.durationMs}ms
Steps: ${traceData.totalSteps} | Tool Calls: ${traceData.totalToolCalls}
Status: ${traceData.maxStepsReached ? 'MAX STEPS REACHED' : 'COMPLETED'}

=== User Input ===
${traceData.userInput}

=== Final Response ===
${traceData.finalResponse || '(No final response)'}

=== Steps ===
${JSON.stringify(traceData.steps, null, 2)}

=== Full Trace Data (JSON) ===
${JSON.stringify(traceData, null, 2)}
`;
    
    // Copy to clipboard
    await navigator.clipboard.writeText(formattedTrace);
    
    // Show success state
    buttonElement.style.background = '#10b981';
    setTimeout(() => {
      buttonElement.style.background = originalBg;
      buttonElement.disabled = false;
    }, 1000);
  } catch (error) {
    console.error('Failed to copy trace data:', error);
    // Show error state
    buttonElement.style.background = '#ef4444';
    setTimeout(() => {
      buttonElement.style.background = originalBg;
      buttonElement.disabled = false;
    }, 1000);
  }
}

// Lazy loading state for reasoning traces
let reasoningTracesState = {
  offset: 0,
  limit: 20,
  loading: false,
  hasMore: true,
  traces: []
};

function formatTraceHtml(trace, isLast = false) {
  const traceStepsId = `trace-steps-${trace.id}`;
  const traceToggleId = `trace-toggle-${trace.id}`;
  return `
    <div class="panel" style="border-left: 3px solid ${trace.maxStepsReached ? '#ef4444' : '#10b981'}; padding: 20px; background: rgba(15, 23, 42, 0.6); border-radius: 8px; transition: all 0.2s; margin-bottom: ${isLast ? '0' : '24px'}; position: relative;" onmouseover="this.style.background='rgba(15, 23, 42, 0.8)'" onmouseout="this.style.background='rgba(15, 23, 42, 0.6)'">
      ${!isLast ? `
        <div style="position: absolute; bottom: -12px; left: 0; right: 0; height: 1px; background: linear-gradient(to right, transparent, rgba(51, 65, 85, 0.6), transparent);"></div>
      ` : ''}
      <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid rgba(51, 65, 85, 0.5);">
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 8px;">
            <h3 style="margin: 0; color: #f97316; font-size: 1rem; font-weight: 600;">
              Trace ${trace.id.slice(0, 8)}
            </h3>
            <span class="status-badge ${trace.maxStepsReached ? 'status-error' : 'status-success'}" style="font-size: 0.7rem; padding: 3px 8px;">
              ${trace.maxStepsReached ? 'Max Steps' : 'Completed'}
            </span>
            <button 
              id="${traceToggleId}"
              onclick="toggleTraceSteps('${trace.id}')"
              style="
                background: rgba(51, 65, 85, 0.5);
                border: 1px solid #334155;
                color: #94a3b8;
                padding: 4px 12px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 0.75rem;
                display: inline-flex;
                align-items: center;
                gap: 4px;
                transition: all 0.2s;
                margin-left: auto;
              "
              onmouseover="this.style.background='rgba(51, 65, 85, 0.7)'"
              onmouseout="this.style.background='rgba(51, 65, 85, 0.5)'"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="transition: transform 0.2s;">
                <path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/>
              </svg>
              Show Details
            </button>
            <button 
              onclick="copyTraceData('${trace.id}', this)"
              style="
                background: transparent;
                border: 1px solid #334155;
                color: #94a3b8;
                padding: 4px 8px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 0.75rem;
                display: inline-flex;
                align-items: center;
                gap: 4px;
                transition: all 0.2s;
              "
              onmouseover="this.style.background='rgba(51, 65, 85, 0.5)'"
              onmouseout="this.style.background='transparent'"
              title="Copy full trace data"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
              </svg>
              Copy
            </button>
          </div>
          <div style="font-size: 0.875rem; color: #cbd5e1; line-height: 1.5; margin-bottom: 8px;">
            ${trace.userInput}
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 12px; font-size: 0.75rem; color: #94a3b8;">
            <span>${trace.totalSteps} step${trace.totalSteps !== 1 ? 's' : ''}</span>
            <span>${trace.totalToolCalls} tool${trace.totalToolCalls !== 1 ? 's' : ''}</span>
            <span>${trace.durationMs}ms</span>
            <span style="color: #64748b;">${new Date(trace.timestamp).toLocaleString()}</span>
          </div>
        </div>
      </div>
      
      <div id="${traceStepsId}" style="display: none; margin-top: 16px;">
        ${trace.steps.map((step, idx) => `
          <div style="margin-bottom: 16px; padding: 12px; background: rgba(15, 23, 42, 0.4); border: 1px solid rgba(51, 65, 85, 0.3); border-radius: 6px;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid rgba(51, 65, 85, 0.3);">
              <span style="background: #f97316; color: white; padding: 4px 10px; border-radius: 4px; font-weight: 600; font-size: 0.8rem;">
                Step ${step.step}
              </span>
              ${step.ragContext ? `
                <span style="background: #8b5cf6; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.75rem;">
                  ${step.ragContext.queryType}
                </span>
              ` : ''}
              ${step.toolCalls.length > 0 ? `
                <span style="background: #10b981; color: white; padding: 4px 8px; border-radius: 4px; font-size: 0.75rem;">
                  ${step.toolCalls.length} tool${step.toolCalls.length > 1 ? 's' : ''}
                </span>
              ` : ''}
            </div>
            
            ${step.toolCalls.length > 0 ? `
              <div style="margin-bottom: 12px;">
                ${step.toolCalls.map(tc => `
                  <div style="margin-bottom: 8px; padding: 10px; background: rgba(30, 41, 59, 0.5); border-radius: 4px; border-left: 3px solid ${tc.result.success ? '#10b981' : '#ef4444'};">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                      <span style="color: #f97316; font-weight: 600; font-size: 0.875rem;">${tc.toolName}</span>
                      <span class="status-badge ${tc.result.success ? 'status-success' : 'status-error'}" style="font-size: 0.7rem; padding: 2px 6px;">
                        ${tc.result.success ? 'Success' : 'Failed'}
                      </span>
                      <span style="color: #94a3b8; font-size: 0.75rem;">${tc.durationMs}ms</span>
                      ${tc.result.error ? `
                        <span style="color: #ef4444; font-size: 0.75rem; margin-left: auto;">Error</span>
                      ` : ''}
                    </div>
                    ${tc.result.error ? `
                      <div style="color: #ef4444; font-size: 0.8rem; padding: 6px; background: rgba(239, 68, 68, 0.1); border-radius: 4px; margin-top: 6px;">
                        ${tc.result.error.length > 150 ? tc.result.error.substring(0, 150) + '...' : tc.result.error}
                      </div>
                    ` : ''}
                  </div>
                `).join('')}
              </div>
            ` : ''}
            
            ${step.llmResponse ? `
              <div style="margin-bottom: 12px; padding: 10px; background: rgba(30, 41, 59, 0.5); border-radius: 4px; border-left: 3px solid #f97316;">
                <div style="color: #e2e8f0; line-height: 1.6; font-size: 0.875rem;">${formatFinalResponse(step.llmResponse)}</div>
              </div>
            ` : ''}
          </div>
        `).join('')}
        
        ${trace.finalResponse ? `
          <div style="margin-top: 12px; padding: 12px; background: rgba(30, 41, 59, 0.5); border-radius: 6px; border-left: 3px solid #10b981;">
            <div style="color: #e2e8f0; line-height: 1.6; font-size: 0.875rem;" class="formatted-response">${formatFinalResponse(trace.finalResponse)}</div>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

async function loadMoreReasoningTraces() {
  const element = document.getElementById('reasoning-traces');
  if (!element || reasoningTracesState.loading || !reasoningTracesState.hasMore) return;
  
  reasoningTracesState.loading = true;
  
  // Show loading indicator at bottom
  const loaderId = 'reasoning-traces-loader';
  let loader = document.getElementById(loaderId);
  if (!loader) {
    loader = document.createElement('div');
    loader.id = loaderId;
    loader.innerHTML = createSkeletonLoader('Loading more traces...');
    element.appendChild(loader);
  }
  
  try {
    const response = await fetch(`${API_URL}/api/dashboard/reasoning-traces?limit=${reasoningTracesState.limit}&offset=${reasoningTracesState.offset}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    
    if (!data.traces || data.traces.length === 0) {
      reasoningTracesState.hasMore = false;
      if (loader) loader.remove();
      return;
    }
    
    // Append new traces
    const isLastBatch = data.traces.length < reasoningTracesState.limit;
    const newHtml = data.traces.map((trace, idx) => {
      // Only the last trace in the last batch should not have a divider
      const isLast = idx === data.traces.length - 1 && isLastBatch;
      return formatTraceHtml(trace, isLast);
    }).join('');
    loader.insertAdjacentHTML('beforebegin', newHtml);
    
    // Update state
    reasoningTracesState.traces.push(...data.traces);
    reasoningTracesState.offset += data.traces.length;
    reasoningTracesState.hasMore = data.traces.length === reasoningTracesState.limit;
    
    // Remove loader
    if (loader) loader.remove();
    
    // If we got fewer than requested, no more to load
    if (data.traces.length < reasoningTracesState.limit) {
      reasoningTracesState.hasMore = false;
    }
  } catch (error) {
    console.error('Failed to load more reasoning traces:', error);
    if (loader) {
      loader.innerHTML = `<div class="error" style="padding: 20px; text-align: center;">Failed to load more traces: ${error.message}</div>`;
    }
  } finally {
    reasoningTracesState.loading = false;
  }
}

export async function loadReasoningTraces(reset = false) {
  const element = document.getElementById('reasoning-traces');
  if (!element) return;
  
  // Reset state if requested
  if (reset) {
    reasoningTracesState = {
      offset: 0,
      limit: 20,
      loading: false,
      hasMore: true,
      traces: []
    };
  }
  
  // Show skeleton loader on initial load
  if (reasoningTracesState.offset === 0) {
    element.innerHTML = '';
    element.appendChild(createSkeletonLoader('Loading reasoning traces...'));
  }
  
  try {
    const response = await fetch(`${API_URL}/api/dashboard/reasoning-traces?limit=${reasoningTracesState.limit}&offset=${reasoningTracesState.offset}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    
    if (!data.traces || data.traces.length === 0) {
      if (reasoningTracesState.offset === 0) {
        element.innerHTML = '<p>No reasoning traces found.</p>';
      }
      reasoningTracesState.hasMore = false;
      return;
    }
    
    const html = data.traces.map((trace, idx) => formatTraceHtml(trace, idx === data.traces.length - 1 && !reasoningTracesState.hasMore)).join('');
    
    if (reasoningTracesState.offset === 0) {
      element.innerHTML = html;
    } else {
      element.insertAdjacentHTML('beforeend', html);
    }
    
    // Update state
    reasoningTracesState.traces.push(...data.traces);
    reasoningTracesState.offset += data.traces.length;
    reasoningTracesState.hasMore = data.traces.length === reasoningTracesState.limit;
    
    // Setup infinite scroll
    if (reasoningTracesState.hasMore) {
      // Remove existing scroll listener
      element.removeEventListener('scroll', handleReasoningTracesScroll);
      // Add new scroll listener
      element.addEventListener('scroll', handleReasoningTracesScroll);
    }
  } catch (error) {
    element.innerHTML = 
      `<div class="error">Failed to load reasoning traces: ${error.message}</div>`;
  }
}

function handleReasoningTracesScroll() {
  const element = document.getElementById('reasoning-traces');
  if (!element) return;
  
  // Load more when within 200px of bottom
  const scrollBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
  if (scrollBottom < 200 && !reasoningTracesState.loading && reasoningTracesState.hasMore) {
    loadMoreReasoningTraces();
  }
}

// Toggle show/hide all steps for a trace
window.toggleTraceSteps = function(traceId) {
  const stepsDiv = document.getElementById(`trace-steps-${traceId}`);
  const toggleBtn = document.getElementById(`trace-toggle-${traceId}`);
  
  if (!stepsDiv || !toggleBtn) return;
  
  const isHidden = stepsDiv.style.display === 'none';
  stepsDiv.style.display = isHidden ? 'block' : 'none';
  
  const svg = toggleBtn.querySelector('svg');
  if (svg) {
    svg.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
  }
  
  toggleBtn.innerHTML = isHidden 
    ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="transition: transform 0.2s; transform: rotate(180deg);"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg> Hide Details`
    : `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="transition: transform 0.2s;"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg> Show Details`;
};
