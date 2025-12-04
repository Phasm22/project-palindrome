import { API_URL } from './utils.js';
import { addTooltip, createModal } from './ui-helpers.js';

export async function loadToolExecutions() {
  const element = document.getElementById('tool-executions');
  if (!element) return;
  
  element.innerHTML = '<div class="loading">Loading...</div>';
  
  try {
    const response = await fetch(`${API_URL}/api/dashboard/tool-executions?limit=50`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    
    if (!data.executions || data.executions.length === 0) {
      document.getElementById('tool-executions').innerHTML = '<p>No tool executions found.</p>';
      return;
    }
    
    const html = `
      <table>
        <tr>
          <th>Timestamp</th>
          <th>Tool</th>
          <th>User</th>
          <th>Status</th>
          <th>Duration</th>
          <th>Parameters</th>
        </tr>
        ${data.executions.map((e, idx) => `
          <tr>
            <td>${new Date(e.timestamp).toLocaleString()}</td>
            <td>
              <span 
                data-tooltip="${e.toolName}"
                style="cursor: help; border-bottom: 1px dotted #94a3b8;"
              >
                ${e.toolName}
              </span>
            </td>
            <td>${e.userId}</td>
            <td>
              <span 
                class="status-badge ${e.error ? 'status-error' : 'status-success'}"
                data-tooltip="${e.error ? `Error: ${e.error}` : 'Execution completed successfully'}"
                style="cursor: help;"
              >
                ${e.error ? 'Failed' : 'Success'}
              </span>
            </td>
            <td>${e.durationMs}ms</td>
            <td>
              <button
                onclick="showExecutionDetails(${idx})"
                style="
                  background: #1e3a8a;
                  border: 1px solid #3b82f6;
                  color: #e2e8f0;
                  padding: 4px 8px;
                  border-radius: 4px;
                  cursor: pointer;
                  font-size: 0.85em;
                "
                data-execution-idx="${idx}"
              >
                View Details
              </button>
            </td>
          </tr>
        `).join('')}
      </table>
    `;
    
    document.getElementById('tool-executions').innerHTML = html;
    
    // Store executions data globally for modal access
    window.executionsData = data.executions;
    
    // Add tooltips to elements with data-tooltip attribute
    document.querySelectorAll('[data-tooltip]').forEach(el => {
      const text = el.getAttribute('data-tooltip');
      addTooltip(el, text);
    });
  } catch (error) {
    document.getElementById('tool-executions').innerHTML = 
      `<div class="error">Failed to load tool executions: ${error.message}</div>`;
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

