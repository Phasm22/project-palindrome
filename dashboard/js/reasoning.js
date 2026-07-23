import {
  API_URL,
  beginContentRefresh,
  endContentRefresh,
  escapeHtml,
} from './utils.js';
import { createSkeletonLoader } from './skeletons.js';
import { renderTextBlock, renderAdaptiveValue } from './response-renderer.js';

function formatDurationMs(ms) {
  if (!ms && ms !== 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

// Format tool results for readable display
export function formatToolResult(dataPreview, toolName) {
  if (!dataPreview) return '';
  
  try {
    // Try to parse as JSON
    const data = typeof dataPreview === 'string' ? JSON.parse(dataPreview) : dataPreview;
    
    // Handle Proxmox VM list
    if (data.vms && Array.isArray(data.vms)) {
      return `
        <div style="font-size: 0.8rem;">
          <div style="color: #10b981; margin-bottom: 8px; font-weight: 600;">
            📦 ${escapeHtml(String(data.vms.length))} VM${data.vms.length !== 1 ? 's' : ''} found
          </div>
          <div style="display: grid; gap: 6px;">
            ${data.vms.slice(0, 10).map(vm => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #1e293b; border-radius: 4px;">
                <span style="width: 8px; height: 8px; border-radius: 50%; background: ${vm.status === 'running' ? '#10b981' : '#94a3b8'};"></span>
                <span style="color: #f97316; font-weight: 500; min-width: 120px;">${escapeHtml(String(vm.name || vm.vmid))}</span>
                <span style="color: #94a3b8; font-size: 0.75rem;">ID: ${escapeHtml(String(vm.vmid))}</span>
                <span style="color: #94a3b8; font-size: 0.75rem;">${escapeHtml(String(vm.node || ''))}</span>
                ${vm.mem_normalized ? `<span style="color: #8b5cf6; font-size: 0.75rem;">${escapeHtml(String(vm.mem_normalized.value))}${escapeHtml(String(vm.mem_normalized.unit))}</span>` : ''}
              </div>
            `).join('')}
            ${data.vms.length > 10 ? `<div style="color: #94a3b8; font-size: 0.75rem;">... and ${escapeHtml(String(data.vms.length - 10))} more</div>` : ''}
          </div>
        </div>
      `;
    }
    
    // Handle containers
    if (data.containers && Array.isArray(data.containers)) {
      return `
        <div style="font-size: 0.8rem;">
          <div style="color: #10b981; margin-bottom: 8px; font-weight: 600;">
            🐳 ${escapeHtml(String(data.containers.length))} container${data.containers.length !== 1 ? 's' : ''} found
          </div>
          <div style="display: grid; gap: 6px;">
            ${data.containers.slice(0, 10).map(ct => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #1e293b; border-radius: 4px;">
                <span style="width: 8px; height: 8px; border-radius: 50%; background: ${ct.status === 'running' ? '#10b981' : '#94a3b8'};"></span>
                <span style="color: #f97316; font-weight: 500;">${escapeHtml(String(ct.name || ct.vmid))}</span>
                <span style="color: #94a3b8; font-size: 0.75rem;">ID: ${escapeHtml(String(ct.vmid))}</span>
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
            🖥️ ${escapeHtml(String(data.nodes.length))} node${data.nodes.length !== 1 ? 's' : ''} found
          </div>
          <div style="display: grid; gap: 6px;">
            ${data.nodes.map(node => `
              <div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: #1e293b; border-radius: 4px;">
                <span style="width: 8px; height: 8px; border-radius: 50%; background: ${node.status === 'online' ? '#10b981' : '#ef4444'};"></span>
                <span style="color: #f97316; font-weight: 500;">${escapeHtml(String(node.node))}</span>
                <span style="color: #94a3b8; font-size: 0.75rem;">${escapeHtml(String(node.status))}</span>
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
            🔗 ${escapeHtml(String(data.entities.length))} entit${data.entities.length !== 1 ? 'ies' : 'y'} found
          </div>
          <div style="display: grid; gap: 6px;">
            ${data.entities.slice(0, 8).map(e => `
              <div style="padding: 6px 8px; background: #1e293b; border-radius: 4px; display: flex; gap: 8px; align-items: center;">
                <span style="background: #8b5cf6; color: white; padding: 2px 6px; border-radius: 3px; font-size: 0.7rem;">${escapeHtml(String(e.type || e.labels?.[0] || 'Entity'))}</span>
                <span style="color: #e2e8f0;">${escapeHtml(String(e.name || e.properties?.name || e.id || 'Unknown'))}</span>
              </div>
            `).join('')}
            ${data.entities.length > 8 ? `<div style="color: #94a3b8; font-size: 0.75rem;">... and ${escapeHtml(String(data.entities.length - 8))} more</div>` : ''}
          </div>
        </div>
      `;
    }
    
    // Handle simple success/error responses
    if (data.success !== undefined) {
      return `
        <div style="display: flex; align-items: center; gap: 8px; color: ${data.success ? '#10b981' : '#ef4444'};">
          ${data.success ? '✅' : '❌'} ${escapeHtml(String(data.message || (data.success ? 'Operation successful' : 'Operation failed')))}
        </div>
      `;
    }
    
    // Default: shape-driven adaptive rendering (same renderer the chat view
    // uses) instead of a raw JSON dump — generalizes to any tool's result
    // shape without hand-written per-tool cases.
    return `<div class="trace-tool-result">${renderAdaptiveValue(data)}</div>`;
  } catch (error) {
    // If parsing fails, return as-is
    return `<pre style="background: #0f172a; padding: 8px; border-radius: 4px; font-size: 0.7rem; overflow-x: auto; margin: 0;">${escapeHtml(typeof dataPreview === 'string' ? dataPreview : JSON.stringify(dataPreview))}</pre>`;
  }
}

// Shares the pipe-table/ASCII-fallback/list/code formatting used by the
// chat view (response-renderer.js) instead of maintaining a second, weaker
// regex-only formatter here — this is what previously left TERSE_DATA
// answers like "homebridge | Status=running | Node=YANG" as raw pipes in
// the Reasoning tab even after the chat view was fixed.
function formatFinalResponse(text) {
  if (!text) return '';
  return renderTextBlock(text);
}

/**
 * Copy full trace data to clipboard, formatted for debugging
 */
export async function copyTraceData(traceId, buttonElement) {
  const originalHtml = buttonElement.innerHTML;
  const setButtonLabel = (label, className = '') => {
    buttonElement.classList.remove('is-copying', 'is-copied', 'is-copy-failed');
    if (className) buttonElement.classList.add(className);
    buttonElement.innerHTML = label;
  };

  try {
    setButtonLabel('Copying', 'is-copying');
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
    
    await writeClipboardText(formattedTrace);
    
    setButtonLabel('Copied', 'is-copied');
    setTimeout(() => {
      buttonElement.innerHTML = originalHtml;
      buttonElement.classList.remove('is-copying', 'is-copied', 'is-copy-failed');
      buttonElement.disabled = false;
    }, 1000);
  } catch (error) {
    console.error('Failed to copy trace data:', error);
    setButtonLabel('Copy failed', 'is-copy-failed');
    setTimeout(() => {
      buttonElement.innerHTML = originalHtml;
      buttonElement.classList.remove('is-copying', 'is-copied', 'is-copy-failed');
      buttonElement.disabled = false;
    }, 1400);
  }
}

async function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard API unavailable');
}

// Lazy loading state for reasoning traces
let reasoningTracesState = {
  offset: 0,
  limit: 20,
  loading: false,
  hasMore: true,
  traces: []
};

function formatMetric(count, singular) {
  const value = Number(count || 0);
  return `${value} ${singular}${value === 1 ? '' : 's'}`;
}

function formatTraceTime(timestamp) {
  if (!timestamp) return 'Unknown time';
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return 'Invalid date';
  return date.toLocaleString();
}

function formatTraceHtml(trace, isLast = false) {
  const traceStepsId = `trace-steps-${trace.id}`;
  const traceToggleId = `trace-toggle-${trace.id}`;
  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  const statusLabel = trace.maxStepsReached ? 'Max Steps' : 'Completed';
  const userInput = trace.userInput || '';
  const inputPreview = userInput.length > 260 ? `${userInput.substring(0, 260)}...` : userInput;
  return `
    <div class="trace-row ${trace.maxStepsReached ? 'trace-row-error' : 'trace-row-success'}" style="margin-bottom: ${isLast ? '0' : '10px'};">
      <div class="trace-row-main">
        <div class="trace-row-title">
          <span class="trace-id">Trace ${escapeHtml(String(trace.id || '').slice(0, 8))}</span>
          <span class="trace-tag ${trace.maxStepsReached ? 'trace-tag-error' : 'trace-tag-success'}">${escapeHtml(statusLabel)}</span>
        </div>
        <div class="trace-preview">${escapeHtml(inputPreview)}</div>
        <div class="trace-meta">
          <span>${formatMetric(trace.totalSteps, 'step')}</span>
          <span>${formatMetric(trace.totalToolCalls, 'tool')}</span>
          <span>${escapeHtml(formatDurationMs(trace.durationMs))}</span>
          <span title="${escapeHtml(new Date(trace.timestamp).toLocaleString())}">${escapeHtml(formatTraceTime(trace.timestamp))}</span>
        </div>
      </div>
      <div class="trace-row-actions">
            <button 
              id="${traceToggleId}"
              onclick="toggleTraceSteps('${trace.id}')"
          class="quiet-action table-action"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="transition: transform 0.2s;">
                <path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/>
              </svg>
          Expand
            </button>
            <button 
              onclick="copyTraceData('${trace.id}', this)"
          class="quiet-action table-action trace-copy-button"
              title="Copy full trace data"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
              </svg>
              Copy
            </button>
      </div>
      
      <div id="${traceStepsId}" class="trace-details" style="display: none;">
        ${steps.map((step, idx) => {
          const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
          return `
          <div class="trace-step">
            <div class="trace-step-heading">
              <span class="trace-tag trace-tag-neutral">
                Step ${escapeHtml(step.step ?? idx + 1)}
              </span>
              ${step.ragContext ? `
                <span class="trace-tag trace-tag-neutral">
                  ${escapeHtml(step.ragContext.queryType || 'RAG')}
                </span>
              ` : ''}
              ${toolCalls.length > 0 ? `
                <span class="trace-tag trace-tag-success">
                  ${formatMetric(toolCalls.length, 'tool')}
                </span>
              ` : ''}
            </div>
            
            ${toolCalls.length > 0 ? `
              <div class="trace-tool-list">
                ${toolCalls.map(tc => {
                  const success = tc.result?.success !== false;
                  return `
                  <div class="trace-tool-row ${success ? 'trace-tool-success' : 'trace-tool-error'}">
                    <div class="trace-tool-heading">
                      <span class="trace-tool-name">${escapeHtml(tc.toolName || 'Unknown tool')}</span>
                      <span class="trace-tag ${success ? 'trace-tag-success' : 'trace-tag-error'}">
                        ${success ? 'Success' : 'Failed'}
                      </span>
                      <span class="trace-tool-duration">${escapeHtml(formatDurationMs(tc.durationMs))}</span>
                      ${tc.result?.error ? `
                        <span class="trace-tool-error-label">Error</span>
                      ` : ''}
                    </div>
                    ${tc.result?.error ? `
                      <div class="trace-tool-error-message">
                        ${escapeHtml(tc.result.error.length > 180 ? `${tc.result.error.substring(0, 180)}...` : tc.result.error)}
                      </div>
                    ` : ''}
                    ${success && tc.result?.dataPreview ? formatToolResult(tc.result.dataPreview, tc.toolName) : ''}
                  </div>
                `;
                }).join('')}
              </div>
            ` : ''}
            
            ${step.llmResponse ? `
              <div class="trace-response">
                ${formatFinalResponse(step.llmResponse)}
              </div>
            ` : ''}
          </div>
        `;
        }).join('')}
        
        ${trace.finalResponse ? `
          <div class="trace-response trace-final-response">
            ${formatFinalResponse(trace.finalResponse)}
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
      loader.innerHTML = `<div class="error" style="padding: 20px; text-align: center;">Failed to load more traces: ${escapeHtml(error.message)}</div>`;
    }
  } finally {
    reasoningTracesState.loading = false;
  }
}

export async function loadReasoningTraces(reset = false) {
  const element = document.getElementById('reasoning-traces');
  if (!element || reasoningTracesState.loading) return;

  const requestOffset = reset ? 0 : reasoningTracesState.offset;
  const hasContent = reset
    && reasoningTracesState.traces.length > 0
    && Boolean(element.querySelector('.trace-row'));

  reasoningTracesState.loading = true;
  beginContentRefresh(element, hasContent, 'Updating traces');
  
  // Show skeleton loader on initial load
  if (requestOffset === 0 && !hasContent) {
    element.innerHTML = '';
    element.appendChild(createSkeletonLoader('Loading reasoning traces...'));
  }
  
  try {
    const response = await fetch(`${API_URL}/api/dashboard/reasoning-traces?limit=${reasoningTracesState.limit}&offset=${requestOffset}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    
    if (!data.traces || data.traces.length === 0) {
      if (requestOffset === 0) {
        element.innerHTML = '<p>No reasoning traces found.</p>';
        reasoningTracesState.traces = [];
        reasoningTracesState.offset = 0;
      }
      reasoningTracesState.hasMore = false;
      return;
    }
    
    const html = data.traces.map((trace, idx) => formatTraceHtml(trace, idx === data.traces.length - 1 && !reasoningTracesState.hasMore)).join('');
    
    if (requestOffset === 0) {
      element.innerHTML = html;
    } else {
      element.insertAdjacentHTML('beforeend', html);
    }
    
    // Update state
    if (requestOffset === 0) {
      reasoningTracesState.traces = [...data.traces];
      reasoningTracesState.offset = data.traces.length;
    } else {
      reasoningTracesState.traces.push(...data.traces);
      reasoningTracesState.offset += data.traces.length;
    }
    reasoningTracesState.hasMore = data.traces.length === reasoningTracesState.limit;
    
    // Setup infinite scroll
    if (reasoningTracesState.hasMore) {
      // Remove existing scroll listener
      element.removeEventListener('scroll', handleReasoningTracesScroll);
      // Add new scroll listener
      element.addEventListener('scroll', handleReasoningTracesScroll);
    }
  } catch (error) {
    if (hasContent) {
      console.error('Failed to refresh reasoning traces:', error);
    } else {
      element.innerHTML =
        `<div class="error">Failed to load reasoning traces: ${escapeHtml(error.message)}</div>`;
    }
  } finally {
    reasoningTracesState.loading = false;
    endContentRefresh(element);
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
    ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="transition: transform 0.2s; transform: rotate(180deg);"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg> Collapse`
    : `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="transition: transform 0.2s;"><path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/></svg> Expand`;
};
