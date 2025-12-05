import { API_URL, renderResponsiveTable } from './utils.js';

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
        <div class="mt-4 md:mt-6 pt-4 md:pt-6 border-t border-slate-700">
          <h3 class="text-base md:text-lg font-semibold mb-3 md:mb-4 text-red-400">Recent Errors</h3>
          ${renderResponsiveTable(
            ['Tool', 'User', 'Error', 'Time'],
            stats.recentErrors,
            (e) => `
              <td class="whitespace-nowrap">${(e.toolName || 'Unknown').split('\n')[0]}</td>
              <td class="whitespace-nowrap">${(e.userId || 'Unknown').split('\n')[0]}</td>
              <td class="max-w-md truncate" title="${(e.error || 'Unknown').replace(/"/g, '&quot;')}">${(e.error || 'Unknown').split('\n')[0]}</td>
              <td class="whitespace-nowrap">${new Date(e.timestamp).toLocaleString()}</td>
            `
          )}
        </div>
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
    
    // Format cluster status nicely
    const formatBytes = (bytes) => {
      if (!bytes) return 'N/A';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let size = bytes;
      let unitIndex = 0;
      while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
      }
      return `${size.toFixed(2)} ${units[unitIndex]}`;
    };
    
    const formatUptime = (seconds) => {
      if (!seconds) return 'N/A';
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      if (days > 0) return `${days}d ${hours}h`;
      if (hours > 0) return `${hours}h ${minutes}m`;
      return `${minutes}m`;
    };
    
    const html = `
      <div style="margin-bottom: 20px;">
        <div class="status-grid">
          <div class="stat-card">
            <div class="stat-label">Nodes</div>
            <div class="stat-value">${data.nodes?.total || 0}</div>
            <div style="font-size: 0.75em; color: #94a3b8; margin-top: 4px;">
              ${data.nodes?.online || 0} online, ${data.nodes?.offline || 0} offline
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">VMs</div>
            <div class="stat-value">${data.vms?.total || 0}</div>
            <div style="font-size: 0.75em; color: #94a3b8; margin-top: 4px;">
              ${data.vms?.running || 0} running, ${data.vms?.stopped || 0} stopped
            </div>
          </div>
          ${data.isCluster ? `
            <div class="stat-card">
              <div class="stat-label">Quorum</div>
              <div class="stat-value">
                <span class="status-badge ${data.quorum?.quorate ? 'status-success' : 'status-error'}" title="${data.quorum ? `Votes: ${data.quorum.votes || 0}/${data.quorum.expected_votes || 0}` : 'Quorum status unavailable'}">
                  ${data.quorum?.quorate ? 'OK' : 'No Quorum'}
                </span>
              </div>
              ${data.quorum ? `
                <div style="font-size: 0.75em; color: #94a3b8; margin-top: 4px;">
                  ${data.quorum.votes || 0}/${data.quorum.expected_votes || 0} votes
                </div>
              ` : data.isCluster ? `
                <div style="font-size: 0.75em; color: #fbbf24; margin-top: 4px;">
                  Quorum data unavailable
                </div>
              ` : ''}
            </div>
          ` : ''}
        </div>
      </div>
      
      ${data.nodes?.list && data.nodes.list.length > 0 ? `
        <h3 style="margin-top: 20px; margin-bottom: 10px; color: #e2e8f0;">Nodes</h3>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 15px;">
          ${data.nodes.list.map(node => `
            <div style="padding: 15px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; border-left: 3px solid ${node.status === 'online' ? '#10b981' : '#ef4444'};">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <strong style="color: #e2e8f0; font-size: 1.1em;">${node.name || 'Unknown'}</strong>
                <span class="status-badge ${node.status === 'online' ? 'status-success' : 'status-error'}">
                  ${node.status || 'unknown'}
                </span>
              </div>
              <div style="font-size: 0.875em; color: #94a3b8; line-height: 1.6;">
                ${node.cpu ? `<div><strong>CPU:</strong> ${(node.cpu * 100).toFixed(1)}%</div>` : ''}
                ${node.memory ? `<div><strong>Memory:</strong> ${formatBytes(node.memory)}</div>` : ''}
                ${node.uptime ? `<div><strong>Uptime:</strong> ${formatUptime(node.uptime)}</div>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
      
      ${data.vms?.resources && data.vms.resources.length > 0 ? `
        <h3 style="margin-top: 20px; margin-bottom: 10px; color: #e2e8f0; font-size: 1rem;">Recent VMs</h3>
        <div style="max-height: 400px; overflow-y: auto;">
          ${renderResponsiveTable(
            ['Name', 'Node', 'Status', 'Type'],
            data.vms.resources.slice(0, 20),
            (vm) => {
              const name = (vm.name || vm.id || 'Unknown').split('\n')[0];
              const node = (vm.node || 'N/A').split('\n')[0];
              const type = (vm.type || 'N/A').split('\n')[0];
              return `
                <td class="whitespace-nowrap">${name}</td>
                <td class="whitespace-nowrap">${node}</td>
                <td>
                  <span class="status-badge ${vm.status === 'running' ? 'status-success' : vm.status === 'stopped' ? 'status-error' : 'status-warning'}">
                    ${vm.status || 'unknown'}
                  </span>
                </td>
                <td class="whitespace-nowrap">${type}</td>
              `;
            }
          )}
        </div>
      ` : ''}
      
      <details style="margin-top: 20px; padding: 10px; background: #0f172a; border: 1px solid #334155; border-radius: 4px;">
        <summary style="cursor: pointer; color: #94a3b8; font-size: 0.875em;">Show Raw JSON</summary>
        <pre style="margin-top: 10px; padding: 10px; background: #1e293b; border-radius: 4px; overflow-x: auto; font-size: 0.75em;">${JSON.stringify(data, null, 2)}</pre>
      </details>
    `;
    
    document.getElementById('cluster-status').innerHTML = html;
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

