import { API_URL, renderResponsiveTable } from './utils.js';
import { addTooltip, createModal } from './ui-helpers.js';
import { createSkeletonLoader, createSkeletonTableRows } from './skeletons.js';

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
  return `
    <td class="whitespace-nowrap">${new Date(e.timestamp).toLocaleString()}</td>
    <td class="whitespace-nowrap">
      <span 
        data-tooltip="${toolName.replace(/"/g, '&quot;')}"
        style="cursor: help; border-bottom: 1px dotted #94a3b8;"
      >
        ${toolName}
      </span>
    </td>
    <td class="whitespace-nowrap">${userId}</td>
    <td>
      <span 
        class="status-badge ${e.error ? 'status-error' : 'status-success'}"
        data-tooltip="${error ? `Error: ${error.replace(/"/g, '&quot;')}` : 'Execution completed successfully'}"
        style="cursor: help;"
      >
        ${e.error ? 'Failed' : 'Success'}
      </span>
    </td>
    <td class="whitespace-nowrap">${e.durationMs}ms</td>
    <td>
      <button
        onclick="showExecutionDetails(${idx})"
        class="bg-primary-600 hover:bg-primary-700 border border-primary-500 text-white px-3 py-2 rounded text-sm cursor-pointer transition-colors min-h-[44px] md:min-h-0"
        data-execution-idx="${idx}"
      >
        View Details
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
    loaderRow.innerHTML = `<td colspan="6" style="text-align: center; padding: 20px; color: #ef4444;">Failed to load more executions: ${error.message}</td>`;
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
      ['Timestamp', 'Tool', 'User', 'Status', 'Duration', 'Parameters'],
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
      `<div class="error">Failed to load tool executions: ${error.message}</div>`;
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

// Show execution details in a modal
window.showExecutionDetails = function(idx) {
  if (!window.executionsData || !window.executionsData[idx]) return;
  
  const exec = window.executionsData[idx];
  const content = `
    <div style="font-size: 0.9em;">
      <div style="margin-bottom: 15px;">
        <strong style="color: #94a3b8;">Tool:</strong>
        <div style="color: #e2e8f0; margin-top: 4px;">${exec.toolName}</div>
      </div>
      
      <div style="margin-bottom: 15px;">
        <strong style="color: #94a3b8;">User:</strong>
        <div style="color: #e2e8f0; margin-top: 4px;">${exec.userId}</div>
      </div>
      
      <div style="margin-bottom: 15px;">
        <strong style="color: #94a3b8;">Status:</strong>
        <div style="margin-top: 4px;">
          <span class="status-badge ${exec.error ? 'status-error' : 'status-success'}">
            ${exec.error ? 'Failed' : 'Success'}
          </span>
        </div>
      </div>
      
      ${exec.error ? `
        <div style="margin-bottom: 15px;">
          <strong style="color: #94a3b8;">Error:</strong>
          <div style="color: #ef4444; margin-top: 4px; padding: 8px; background: #1e293b; border-radius: 4px; font-family: monospace; font-size: 0.85em;">
            ${exec.error}
          </div>
        </div>
      ` : ''}
      
      <div style="margin-bottom: 15px;">
        <strong style="color: #94a3b8;">Duration:</strong>
        <div style="color: #e2e8f0; margin-top: 4px;">${exec.durationMs}ms</div>
      </div>
      
      <div style="margin-bottom: 15px;">
        <strong style="color: #94a3b8;">Timestamp:</strong>
        <div style="color: #e2e8f0; margin-top: 4px;">${new Date(exec.timestamp).toLocaleString()}</div>
      </div>
      
      <div style="margin-bottom: 15px;">
        <strong style="color: #94a3b8;">Parameters:</strong>
        <pre style="margin-top: 8px; padding: 10px; background: #0f172a; border: 1px solid #334155; border-radius: 4px; overflow-x: auto; font-size: 0.85em; max-height: 300px; overflow-y: auto;">${JSON.stringify(exec.parameters, null, 2)}</pre>
      </div>
      
      ${exec.result ? `
        <div style="margin-bottom: 15px;">
          <strong style="color: #94a3b8;">Result:</strong>
          <pre style="margin-top: 8px; padding: 10px; background: #0f172a; border: 1px solid #334155; border-radius: 4px; overflow-x: auto; font-size: 0.85em; max-height: 300px; overflow-y: auto;">${JSON.stringify(exec.result, null, 2)}</pre>
        </div>
      ` : ''}
    </div>
  `;
  
  createModal(`Tool Execution Details`, content, {
    width: '700px',
    height: 'auto',
  });
};
