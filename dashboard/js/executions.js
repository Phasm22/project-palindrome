import { API_URL, escapeHtml, renderResponsiveTable } from './utils.js';
import { addTooltip } from './ui-helpers.js';
import { showModal } from './modal.js';
import { createSkeletonLoader } from './skeletons.js';

// Lazy loading state for tool executions
let toolExecutionsState = {
  offset: 0,
  limit: 50,
  loading: false,
  hasMore: true,
  executions: []
};

function formatExecutionRow(e, idx) {
  const toolName = (e.toolName || 'Unknown').split('\n')[0];
  const userId = (e.userId || 'Unknown').split('\n')[0];
  const error = e.error ? (e.error || 'Unknown').split('\n')[0] : null;
  const duration = e.durationMs !== undefined && e.durationMs !== null ? `${e.durationMs}ms` : 'N/A';
  return `
    <td class="whitespace-nowrap">${escapeHtml(new Date(e.timestamp).toLocaleString())}</td>
    <td class="whitespace-nowrap">
      <span 
        data-tooltip="${escapeHtml(toolName)}"
        style="cursor: help; border-bottom: 1px dotted #94a3b8;"
      >
        ${escapeHtml(toolName)}
      </span>
    </td>
    <td class="whitespace-nowrap">${escapeHtml(userId)}</td>
    <td>
      <span 
        class="status-badge ${e.error ? 'status-error' : 'status-success'}"
        data-tooltip="${error ? `Error: ${escapeHtml(error)}` : 'Execution completed successfully'}"
        style="cursor: help;"
      >
        ${e.error ? 'Failed' : 'Success'}
      </span>
    </td>
    <td class="whitespace-nowrap">${escapeHtml(duration)}</td>
    <td>
      <button
        onclick="showExecutionDetails(${idx})"
        class="quiet-action table-action"
        data-execution-idx="${idx}"
      >
        Details
      </button>
    </td>
  `;
}

async function loadMoreToolExecutions() {
  const element = document.getElementById('tool-executions');
  if (!element || toolExecutionsState.loading || !toolExecutionsState.hasMore) return;
  
  toolExecutionsState.loading = true;
  
  // Find the table body to append to
  const tbody = element.querySelector('tbody');
  if (!tbody) return;
  
  // Show loading indicator
  const loaderRow = document.createElement('tr');
  loaderRow.id = 'tool-executions-loader';
  loaderRow.innerHTML = `<td colspan="6" style="text-align: center; padding: 20px;">${createSkeletonLoader('Loading more executions...')}</td>`;
  tbody.appendChild(loaderRow);
  
  try {
    const response = await fetch(`${API_URL}/api/dashboard/tool-executions?limit=${toolExecutionsState.limit}&offset=${toolExecutionsState.offset}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    
    if (!data.executions || data.executions.length === 0) {
      toolExecutionsState.hasMore = false;
      loaderRow.remove();
      return;
    }
    
    // Calculate starting index for new rows
    const startIdx = toolExecutionsState.executions.length;
    
    // Append new rows
    data.executions.forEach((exec, i) => {
      const row = document.createElement('tr');
      row.innerHTML = formatExecutionRow(exec, startIdx + i);
      loaderRow.insertAdjacentElement('beforebegin', row);
    });
    
    // Update state
    toolExecutionsState.executions.push(...data.executions);
    toolExecutionsState.offset += data.executions.length;
    toolExecutionsState.hasMore = data.executions.length === toolExecutionsState.limit;
    
    // Update global executions data for modal access
    window.executionsData = toolExecutionsState.executions;
    
    // Add tooltips to new elements
    tbody.querySelectorAll('[data-tooltip]').forEach(el => {
      if (!el.hasAttribute('data-tooltip-processed')) {
        const text = el.getAttribute('data-tooltip');
        addTooltip(el, text);
        el.setAttribute('data-tooltip-processed', 'true');
      }
    });
    
    // Remove loader
    loaderRow.remove();
    
    // If we got fewer than requested, no more to load
    if (data.executions.length < toolExecutionsState.limit) {
      toolExecutionsState.hasMore = false;
    }
  } catch (error) {
    console.error('Failed to load more tool executions:', error);
    loaderRow.innerHTML = `<td colspan="6" style="text-align: center; padding: 20px; color: #ef4444;">Failed to load more executions: ${escapeHtml(error.message)}</td>`;
  } finally {
    toolExecutionsState.loading = false;
  }
}

export async function loadToolExecutions(reset = false) {
  const element = document.getElementById('tool-executions');
  if (!element) return;
  
  // Reset state if requested
  if (reset) {
    toolExecutionsState = {
      offset: 0,
      limit: 50,
      loading: false,
      hasMore: true,
      executions: []
    };
  }
  
  // Show skeleton loader on initial load
  if (toolExecutionsState.offset === 0) {
    element.innerHTML = '';
    element.appendChild(createSkeletonLoader('Loading executions...'));
  }
  
  try {
    const response = await fetch(`${API_URL}/api/dashboard/tool-executions?limit=${toolExecutionsState.limit}&offset=${toolExecutionsState.offset}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    
    if (!data.executions || data.executions.length === 0) {
      if (toolExecutionsState.offset === 0) {
        element.innerHTML = '<p>No tool executions found.</p>';
      }
      toolExecutionsState.hasMore = false;
      return;
    }
    
    const html = renderResponsiveTable(
      ['Timestamp', 'Tool', 'User', 'Status', 'Duration', 'Details'],
      data.executions,
      (e, idx) => formatExecutionRow(e, idx)
    );
    
    if (toolExecutionsState.offset === 0) {
      element.innerHTML = html;
    } else {
      // Append to existing table
      const tbody = element.querySelector('tbody');
      if (tbody) {
        const startIdx = toolExecutionsState.executions.length;
        data.executions.forEach((exec, i) => {
          const row = document.createElement('tr');
          row.innerHTML = formatExecutionRow(exec, startIdx + i);
          tbody.appendChild(row);
        });
      }
    }
    
    // Update state
    toolExecutionsState.executions.push(...data.executions);
    toolExecutionsState.offset += data.executions.length;
    toolExecutionsState.hasMore = data.executions.length === toolExecutionsState.limit;
    
    // Store executions data globally for modal access
    window.executionsData = toolExecutionsState.executions;
    
    // Add tooltips to elements with data-tooltip attribute
    element.querySelectorAll('[data-tooltip]').forEach(el => {
      if (!el.hasAttribute('data-tooltip-processed')) {
        const text = el.getAttribute('data-tooltip');
        addTooltip(el, text);
        el.setAttribute('data-tooltip-processed', 'true');
      }
    });
    
    // Setup infinite scroll
    if (toolExecutionsState.hasMore) {
      // Remove existing scroll listener
      element.removeEventListener('scroll', handleToolExecutionsScroll);
      // Add new scroll listener
      element.addEventListener('scroll', handleToolExecutionsScroll);
    }
  } catch (error) {
    element.innerHTML = 
      `<div class="error">Failed to load tool executions: ${escapeHtml(error.message)}</div>`;
  }
}

function handleToolExecutionsScroll() {
  const element = document.getElementById('tool-executions');
  if (!element) return;
  
  // Load more when within 200px of bottom
  const scrollBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
  if (scrollBottom < 200 && !toolExecutionsState.loading && toolExecutionsState.hasMore) {
    loadMoreToolExecutions();
  }
}

function stringifyJson(value) {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

function jsonDetails(title, value, open = false) {
  return `
    <details class="dashboard-details modal-json-details" ${open ? 'open' : ''}>
      <summary>${escapeHtml(title)}</summary>
      <pre class="json-block">${escapeHtml(stringifyJson(value))}</pre>
    </details>
  `;
}

window.showExecutionDetails = function(idx) {
  if (!window.executionsData || !window.executionsData[idx]) return;
  
  const exec = window.executionsData[idx];
  const hasResult = Object.prototype.hasOwnProperty.call(exec, 'result');
  const content = `
    <div class="execution-detail-modal">
      <div class="summary-grid">
        <div>
          <span class="summary-label">Tool</span>
          <span class="summary-value">${escapeHtml(exec.toolName || 'Unknown')}</span>
        </div>
        <div>
          <span class="summary-label">User</span>
          <span class="summary-value">${escapeHtml(exec.userId || 'Unknown')}</span>
        </div>
        <div>
          <span class="summary-label">Status</span>
          <span class="status-badge status-badge-dense ${exec.error ? 'status-error' : 'status-success'}">${exec.error ? 'Failed' : 'Success'}</span>
        </div>
        <div>
          <span class="summary-label">Duration</span>
          <span class="summary-value">${escapeHtml(exec.durationMs !== undefined && exec.durationMs !== null ? `${exec.durationMs}ms` : 'N/A')}</span>
        </div>
        <div class="summary-grid-wide">
          <span class="summary-label">Timestamp</span>
          <span class="summary-value">${escapeHtml(new Date(exec.timestamp).toLocaleString())}</span>
        </div>
      </div>

      ${exec.error ? jsonDetails('Error', exec.error, true) : ''}
      ${jsonDetails('Parameters', exec.parameters ?? {}, false)}
      ${hasResult ? jsonDetails('Result', exec.result, false) : ''}
    </div>
  `;
  
  showModal({
    title: 'Tool Execution Details',
    content,
    maxWidth: '760px',
  });
};
