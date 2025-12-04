import { API_URL } from './utils.js';

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
        ${data.executions.map(e => `
          <tr>
            <td>${new Date(e.timestamp).toLocaleString()}</td>
            <td>${e.toolName}</td>
            <td>${e.userId}</td>
            <td>
              <span class="status-badge ${e.error ? 'status-error' : 'status-success'}">
                ${e.error ? 'Failed' : 'Success'}
              </span>
            </td>
            <td>${e.durationMs}ms</td>
            <td><pre>${JSON.stringify(e.parameters, null, 2).slice(0, 100)}...</pre></td>
          </tr>
        `).join('')}
      </table>
    `;
    
    document.getElementById('tool-executions').innerHTML = html;
  } catch (error) {
    document.getElementById('tool-executions').innerHTML = 
      `<div class="error">Failed to load tool executions: ${error.message}</div>`;
  }
}

