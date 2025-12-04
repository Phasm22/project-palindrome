import { API_URL } from './utils.js';

export async function loadExecutionStats() {
  const element = document.getElementById('execution-stats');
  if (!element) return;
  
  try {
    const response = await fetch(`${API_URL}/api/dashboard/execution-stats`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const stats = await response.json();
    
    const html = `
      <div class="status-grid">
        <div class="stat-card">
          <div class="stat-label">Total Executions</div>
          <div class="stat-value">${stats.total || 0}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Error Rate</div>
          <div class="stat-value">${((stats.errorRate || 0) * 100).toFixed(1)}%</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Avg Duration</div>
          <div class="stat-value">${Math.round(stats.avgDurationMs || 0)}ms</div>
        </div>
      </div>
      ${stats.recentErrors && stats.recentErrors.length > 0 ? `
        <h3 style="margin-top: 20px; color: #ef4444;">Recent Errors</h3>
        <table>
          <tr>
            <th>Tool</th>
            <th>User</th>
            <th>Error</th>
            <th>Time</th>
          </tr>
          ${stats.recentErrors.map(e => `
            <tr>
              <td>${e.toolName}</td>
              <td>${e.userId}</td>
              <td>${e.error || 'Unknown'}</td>
              <td>${new Date(e.timestamp).toLocaleString()}</td>
            </tr>
          `).join('')}
        </table>
      ` : ''}
    `;
    
    document.getElementById('execution-stats').innerHTML = html;
  } catch (error) {
    document.getElementById('execution-stats').innerHTML = 
      `<div class="error">Failed to load execution stats: ${error.message}</div>`;
  }
}

export async function loadClusterStatus() {
  const element = document.getElementById('cluster-status');
  if (!element) return;
  
  try {
    const response = await fetch(`${API_URL}/api/dashboard/cluster-status`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    
    document.getElementById('cluster-status').innerHTML = 
      `<pre>${JSON.stringify(data, null, 2)}</pre>`;
  } catch (error) {
    document.getElementById('cluster-status').innerHTML = 
      `<div class="error">Failed to load cluster status: ${error.message}</div>`;
  }
}

export async function loadSystemHealth() {
  const element = document.getElementById('system-health');
  if (!element) return;
  
  try {
    const response = await fetch(`${API_URL}/health`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    
    const html = `
      <div class="status-grid">
        ${Object.entries(data.dependencies || {}).map(([name, status]) => {
          const s = status || {};
          return `
          <div class="stat-card">
            <div class="stat-label">${name}</div>
            <div class="stat-value">
              <span class="status-badge ${s.healthy ? 'status-success' : 'status-error'}">
                ${s.healthy ? 'Healthy' : 'Unhealthy'}
              </span>
            </div>
          </div>
        `;
        }).join('')}
      </div>
    `;
    
    document.getElementById('system-health').innerHTML = html;
  } catch (error) {
    document.getElementById('system-health').innerHTML = 
      `<div class="error">Failed to load system health: ${error.message}</div>`;
  }
}

