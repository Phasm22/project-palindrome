import { API_URL, renderResponsiveTable } from './utils.js';
import { createSkeletonStatsGrid } from './skeletons.js';

/**
 * Format duration in milliseconds to a human-readable string
 * Examples: 8810ms -> "8.81s", 150ms -> "150ms", 120000ms -> "2m"
 */
function formatDuration(ms) {
  if (!ms || ms === 0) return '0ms';
  
  const seconds = ms / 1000;
  const minutes = seconds / 60;
  const hours = minutes / 60;
  
  if (hours >= 1) {
    const h = Math.floor(hours);
    const m = Math.floor(minutes % 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  
  if (minutes >= 1) {
    const m = Math.floor(minutes);
    const s = Math.floor(seconds % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  
  if (seconds >= 1) {
    // Show 1-2 decimal places for seconds
    if (seconds < 10) {
      return `${seconds.toFixed(2)}s`;
    }
    return `${seconds.toFixed(1)}s`;
  }
  
  // Less than 1 second, show milliseconds
  return `${Math.round(ms)}ms`;
}

/**
 * Format a date to relative time (e.g., "5 minutes ago", "2 hours ago", "3 days ago")
 */
function formatRelativeTime(dateString) {
  if (!dateString) return 'Never';
  
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return 'Invalid date';
  
  const now = new Date();
  const diffMs = now - date;
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);
  
  if (diffSeconds < 60) {
    return diffSeconds <= 0 ? 'just now' : `${diffSeconds} second${diffSeconds !== 1 ? 's' : ''} ago`;
  }
  
  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`;
  }
  
  if (diffHours < 24) {
    return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  }
  
  if (diffDays < 7) {
    return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  }
  
  if (diffWeeks < 4) {
    return `${diffWeeks} week${diffWeeks !== 1 ? 's' : ''} ago`;
  }
  
  if (diffMonths < 12) {
    return `${diffMonths} month${diffMonths !== 1 ? 's' : ''} ago`;
  }
  
  return `${diffYears} year${diffYears !== 1 ? 's' : ''} ago`;
}

function beginSoftRefresh(element, skeletonCount) {
  const hadContent = element.dataset.loaded === 'true' && element.innerHTML.trim().length > 0;
  element.setAttribute('aria-busy', 'true');

  if (!hadContent) {
    element.innerHTML = '';
    element.appendChild(createSkeletonStatsGrid(skeletonCount));
    return { hadContent, prevHeight: 0 };
  }

  const prevHeight = element.offsetHeight || 0;
  if (prevHeight > 0) {
    element.style.minHeight = `${prevHeight}px`;
  }
  element.style.transition = 'opacity 120ms ease';
  element.style.opacity = '0.75';
  return { hadContent, prevHeight };
}

function endSoftRefresh(element) {
  element.dataset.loaded = 'true';
  element.removeAttribute('aria-busy');
  element.style.opacity = '';
  element.style.minHeight = '';
  element.style.transition = '';
}

export async function loadExecutionStats() {
  const element = document.getElementById('execution-stats');
  if (!element) return;

  const refresh = beginSoftRefresh(element, 3);
  
  try {
    const response = await fetch(`${API_URL}/api/dashboard/execution-stats`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const stats = await response.json();
    
    const ingestion = stats.ingestion || {};
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
          <div class="stat-value">${formatDuration(stats.avgDurationMs || 0)}</div>
        </div>
      </div>
      ${ingestion.active !== undefined ? `
        <details class="overview-details">
          <summary class="overview-summary">Ingestion Scheduler</summary>
          <div class="overview-details-body">
            <div class="status-grid">
              <div class="stat-card">
                <div class="stat-label">Status</div>
                <div>
                  <span class="status-badge ${ingestion.active ? 'status-success' : 'status-error'}">
                    ${ingestion.active ? 'Active' : 'Inactive'}
                  </span>
                </div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Runs</div>
                <div class="stat-value">${ingestion.runCount || 0}</div>
                <div style="font-size: 0.75em; color: #94a3b8; margin-top: 4px;">
                  ${ingestion.successCount || 0} success, ${ingestion.failureCount || 0} failed
                </div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Success Rate</div>
                <div class="stat-value">${((ingestion.successRate || 0)).toFixed(1)}%</div>
              </div>
              <div class="stat-card">
                <div class="stat-label">Avg Duration</div>
                <div class="stat-value">${formatDuration(ingestion.avgDurationMs || 0)}</div>
              </div>
              ${ingestion.lastRun ? `
                <div class="stat-card">
                  <div class="stat-label">Last Run</div>
                  <div class="stat-value" style="font-size: 0.9em;">${formatRelativeTime(ingestion.lastRun)}</div>
                </div>
              ` : ''}
            </div>
            ${ingestion.proxmoxAvgDurationMs || ingestion.networkAvgDurationMs || ingestion.firewallAvgDurationMs ? `
              <details class="overview-subdetails">
                <summary>Component Durations</summary>
                <div class="overview-details-body">
                  <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; font-size: 0.85em;">
                    ${ingestion.proxmoxAvgDurationMs ? `
                      <div>
                        <span style="color: #94a3b8;">Proxmox:</span>
                        <span style="color: #e2e8f0; margin-left: 8px;">${formatDuration(ingestion.proxmoxAvgDurationMs)}</span>
                      </div>
                    ` : ''}
                    ${ingestion.networkAvgDurationMs ? `
                      <div>
                        <span style="color: #94a3b8;">Network:</span>
                        <span style="color: #e2e8f0; margin-left: 8px;">${formatDuration(ingestion.networkAvgDurationMs)}</span>
                      </div>
                    ` : ''}
                    ${ingestion.firewallAvgDurationMs ? `
                      <div>
                        <span style="color: #94a3b8;">Firewall:</span>
                        <span style="color: #e2e8f0; margin-left: 8px;">${formatDuration(ingestion.firewallAvgDurationMs)}</span>
                      </div>
                    ` : ''}
                  </div>
                </div>
              </details>
            ` : ''}
          </div>
        </details>
      ` : ''}
      ${stats.recentErrors && stats.recentErrors.length > 0 ? `
        <details class="overview-details">
          <summary class="overview-summary text-red-400">Recent Errors</summary>
          <div class="overview-details-body">
            <div class="flex justify-center">
              ${renderResponsiveTable(
                ['Tool', 'User', 'Error', 'Time'],
                stats.recentErrors,
                (e) => `
                  <td class="whitespace-nowrap">${(e.toolName || 'Unknown').split('\n')[0]}</td>
                  <td class="whitespace-nowrap">${(e.userId || 'Unknown').split('\n')[0]}</td>
                  <td class="max-w-md truncate" title="${(e.error || 'Unknown').replace(/"/g, '&quot;')}">${(e.error || 'Unknown').split('\n')[0]}</td>
                  <td class="whitespace-nowrap" title="${new Date(e.timestamp).toLocaleString()}">${formatRelativeTime(e.timestamp)}</td>
                `
              )}
            </div>
          </div>
        </details>
      ` : ''}
    `;
    
    document.getElementById('execution-stats').innerHTML = html;
    endSoftRefresh(element);
  } catch (error) {
    document.getElementById('execution-stats').innerHTML = 
      `<div class="error">Failed to load execution stats: ${error.message}</div>`;
    endSoftRefresh(element);
  }
}

export async function loadClusterStatus() {
  const element = document.getElementById('cluster-status');
  if (!element) return;

  const refresh = beginSoftRefresh(element, 3);
  
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
          <div class="stat-card">
            <div class="stat-label">LXC</div>
            <div class="stat-value">${data.lxc?.total || 0}</div>
            <div style="font-size: 0.75em; color: #94a3b8; margin-top: 4px;">
              ${data.lxc?.running || 0} running, ${data.lxc?.stopped || 0} stopped
            </div>
          </div>
        </div>
      </div>
      
      ${data.nodes?.list && data.nodes.list.length > 0 ? `
        <details class="overview-details">
          <summary class="overview-summary">Nodes (${data.nodes.list.length})</summary>
          <div class="overview-details-body">
            <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;">
              ${data.nodes.list.map(node => `
                <div style="padding: 12px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; border-left: 2px solid ${node.status === 'online' ? '#10b981' : '#ef4444'};">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                    <strong style="color: #e2e8f0; font-size: 1em; font-weight: 600;">${node.name || 'Unknown'}</strong>
                    <span class="status-badge ${node.status === 'online' ? 'status-success' : 'status-error'}">
                      ${node.status || 'unknown'}
                    </span>
                  </div>
                  <div style="font-size: 0.85em; color: #94a3b8; line-height: 1.5;">
                    ${node.cpu ? `<div><strong>CPU:</strong> ${(node.cpu * 100).toFixed(1)}%</div>` : ''}
                    ${node.memory ? `<div><strong>Memory:</strong> ${formatBytes(node.memory)}</div>` : ''}
                    ${node.uptime ? `<div><strong>Uptime:</strong> ${formatUptime(node.uptime)}</div>` : ''}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        </details>
      ` : ''}
      
      ${data.vms?.resources && data.vms.resources.length > 0 ? `
        <details class="overview-details">
          <summary class="overview-summary">Recent VMs (${data.vms.resources.length})</summary>
          <div class="overview-details-body">
            <div style="max-height: 360px; overflow-y: auto; width: 100%;">
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
          </div>
        </details>
      ` : ''}

      ${data.lxc?.resources && data.lxc.resources.length > 0 ? `
        <details class="overview-details">
          <summary class="overview-summary">Recent LXCs (${data.lxc.resources.length})</summary>
          <div class="overview-details-body">
            <div style="max-height: 360px; overflow-y: auto; width: 100%;">
              ${renderResponsiveTable(
                ['Name', 'Node', 'Status', 'Type'],
                data.lxc.resources.slice(0, 20),
                (ct) => {
                  const name = (ct.name || ct.id || 'Unknown').split('\n')[0];
                  const node = (ct.node || 'N/A').split('\n')[0];
                  const type = (ct.type || 'N/A').split('\n')[0];
                  return `
                    <td class="whitespace-nowrap">${name}</td>
                    <td class="whitespace-nowrap">${node}</td>
                    <td>
                      <span class="status-badge ${ct.status === 'running' ? 'status-success' : ct.status === 'stopped' ? 'status-error' : 'status-warning'}">
                        ${ct.status || 'unknown'}
                      </span>
                    </td>
                    <td class="whitespace-nowrap">${type}</td>
                  `;
                }
              )}
            </div>
          </div>
        </details>
      ` : ''}
      
      <details style="margin-top: 20px; padding: 10px; background: #0f172a; border: 1px solid #334155; border-radius: 4px;">
        <summary style="cursor: pointer; color: #94a3b8; font-size: 0.875em;">Show Raw JSON</summary>
        <pre style="margin-top: 10px; padding: 10px; background: #1e293b; border-radius: 4px; overflow-x: auto; font-size: 0.75em;">${JSON.stringify(data, null, 2)}</pre>
      </details>
    `;
    
    document.getElementById('cluster-status').innerHTML = html;
    endSoftRefresh(element);
  } catch (error) {
    // If this was a refresh (not first load), keep existing content and just remove loading state.
    if (refresh.hadContent) {
      console.error('Failed to load cluster status:', error);
      endSoftRefresh(element);
      return;
    }
    document.getElementById('cluster-status').innerHTML =
      `<div class="error">Failed to load cluster status: ${error.message}</div>`;
    endSoftRefresh(element);
  }
}

export async function loadSystemHealth() {
  const element = document.getElementById('system-health');
  const section = document.getElementById('system-health-section');
  if (!element || !section) return;

  // Always keep section stable; avoid hide/show layout jumps.
  section.style.display = '';
  const refresh = beginSoftRefresh(element, 4);
  
  try {
    const response = await fetch(`${API_URL}/health`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    
    const dependencies = data.dependencies || {};
    const entries = Object.entries(dependencies);
    
    // If no dependencies or all empty, show a stable message (no layout shift).
    if (entries.length === 0 || entries.every(([_, status]) => !status)) {
      element.innerHTML = `
        <div class="text-slate-400 text-center py-2 text-sm">
          No dependency health checks configured.
        </div>
      `;
      endSoftRefresh(element);
      return;
    }
    
    const html = `
      <div class="status-grid">
        ${entries.map(([name, status]) => {
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
    
    element.innerHTML = html;
    endSoftRefresh(element);
  } catch (error) {
    if (refresh.hadContent) {
      console.error('Failed to load system health:', error);
      endSoftRefresh(element);
      return;
    }
    element.innerHTML = `
      <div class="text-slate-400 text-center py-2 text-sm">
        System health unavailable.
      </div>
    `;
    endSoftRefresh(element);
  }
}

export async function loadIngestionStatus(reset = false) {
  const element = document.getElementById('ingestion-status');
  const section = document.getElementById('ingestion-status-section');
  if (!element || !section) return;
  
  // Show skeleton loader
  if (reset) {
    element.innerHTML = '';
    element.appendChild(createSkeletonStatsGrid(3));
  }
  
  try {
    const response = await fetch(`${API_URL}/api/dashboard/ingestion-status`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    
    if (!data.active) {
      element.innerHTML = `
        <div class="text-slate-400 text-center py-4">
          <p>Ingestion scheduler is not active</p>
        </div>
      `;
      return;
    }

    const lastRun = data.lastRunDetails;
    const stats = data.statistics || {};
    const nextRun = data.nextRun ? new Date(data.nextRun) : null;
    const now = new Date();
    const timeUntilNext = nextRun ? Math.max(0, Math.floor((nextRun - now) / 1000 / 60)) : null;

    let html = '';

    // Current Status (no heading — cards speak for themselves)
    html += '<div class="mb-4">';
    html += '<div class="status-grid">';
    
    html += `
      <div class="stat-card">
        <div class="stat-label">Scheduler</div>
        <div style="margin-top: 4px;">
          <span class="status-badge ${data.active ? 'status-success' : 'status-error'}">
            ${data.active ? 'Active' : 'Inactive'}
          </span>
        </div>
      </div>
    `;

    html += `
      <div class="stat-card">
        <div class="stat-label">Currently Running</div>
        <div style="margin-top: 4px;">
          <span class="status-badge ${data.isRunning ? 'status-warning' : 'status-success'}">
            ${data.isRunning ? 'Running' : 'Idle'}
          </span>
        </div>
      </div>
    `;

    if (lastRun) {
      html += `
        <div class="stat-card">
          <div class="stat-label">Last Run</div>
          <div class="stat-value text-sm">${formatRelativeTime(lastRun.timestamp)}</div>
        </div>
      `;
    }

    if (timeUntilNext !== null) {
      html += `
        <div class="stat-card">
          <div class="stat-label">Next Run</div>
          <div class="stat-value text-sm">${timeUntilNext > 0 ? `in ${timeUntilNext}m` : 'due now'}</div>
        </div>
      `;
    }

    html += '</div></div>';

    // Last Run Details
    if (lastRun) {
      html += '<details class="overview-details">';
      html += '<summary class="overview-summary">Last Run Details</summary>';
      html += '<div class="overview-details-body">';
      
      html += `
        <div class="status-grid mb-4">
          <div class="stat-card">
            <div class="stat-label">Status</div>
            <div>
              <span class="status-badge ${lastRun.success ? 'status-success' : 'status-error'}">
                ${lastRun.success ? 'Success' : 'Failed'}
              </span>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Duration</div>
            <div class="stat-value">${formatDuration(lastRun.duration)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Timestamp</div>
            <div class="stat-value" style="font-size: 0.85em;">${new Date(lastRun.timestamp).toLocaleString()}</div>
          </div>
        </div>
      `;

      // Per-source breakdown
      html += '<div class="space-y-3">';
      
      // Proxmox
      html += `
        <div class="flex items-center justify-between p-2 bg-slate-900 rounded">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-slate-300">Proxmox</span>
            <span class="status-badge ${lastRun.proxmox.success ? 'status-success' : 'status-error'}" style="font-size: 0.7rem; padding: 2px 6px;">
              ${lastRun.proxmox.success ? '✓' : '✗'}
            </span>
          </div>
          <div class="text-xs text-slate-400">${formatDuration(lastRun.proxmox.duration)}</div>
        </div>
      `;
      if (lastRun.proxmox.error) {
        html += `<div class="text-xs text-red-400 ml-4 mb-2">${escapeHtml(lastRun.proxmox.error.substring(0, 100))}${lastRun.proxmox.error.length > 100 ? '...' : ''}</div>`;
      }

      // Network
      html += `
        <div class="flex items-center justify-between p-2 bg-slate-900 rounded">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-slate-300">Network</span>
            <span class="status-badge ${lastRun.network.success ? 'status-success' : 'status-error'}" style="font-size: 0.7rem; padding: 2px 6px;">
              ${lastRun.network.success ? '✓' : '✗'}
            </span>
            ${lastRun.network.entities !== undefined ? `<span class="text-xs text-slate-500">(${lastRun.network.entities} entities)</span>` : ''}
          </div>
          <div class="text-xs text-slate-400">${formatDuration(lastRun.network.duration)}</div>
        </div>
      `;
      if (lastRun.network.error) {
        html += `<div class="text-xs text-red-400 ml-4 mb-2">${escapeHtml(lastRun.network.error.substring(0, 100))}${lastRun.network.error.length > 100 ? '...' : ''}</div>`;
      }

      // Firewall
      html += `
        <div class="flex items-center justify-between p-2 bg-slate-900 rounded">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-slate-300">Firewall</span>
            <span class="status-badge ${lastRun.firewall.success ? 'status-success' : 'status-error'}" style="font-size: 0.7rem; padding: 2px 6px;">
              ${lastRun.firewall.success ? '✓' : '✗'}
            </span>
            ${lastRun.firewall.entities !== undefined ? `<span class="text-xs text-slate-500">(${lastRun.firewall.entities} rules)</span>` : ''}
          </div>
          <div class="text-xs text-slate-400">${formatDuration(lastRun.firewall.duration)}</div>
        </div>
      `;
      if (lastRun.firewall.error) {
        html += `<div class="text-xs text-red-400 ml-4 mb-2">${escapeHtml(lastRun.firewall.error.substring(0, 100))}${lastRun.firewall.error.length > 100 ? '...' : ''}</div>`;
      }

      // Temperature
      if (lastRun.temperature) {
        html += `
          <div class="flex items-center justify-between p-2 bg-slate-900 rounded">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-slate-300">Temperature</span>
              <span class="text-xs text-slate-500">
                ${lastRun.temperature.nodesWithTemp} nodes with data, ${lastRun.temperature.nodesWithoutTemp} without
              </span>
            </div>
          </div>
        `;
      }

      // Cleanup
      if (lastRun.cleanup.deleted > 0) {
        html += `
          <div class="flex items-center justify-between p-2 bg-slate-900 rounded">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-slate-300">Cleanup</span>
              <span class="text-xs text-slate-500">Deleted ${lastRun.cleanup.deleted} stale entities</span>
            </div>
            <div class="text-xs text-slate-400">${formatDuration(lastRun.cleanup.duration)}</div>
          </div>
        `;
      }

      html += '</div></div></details>';
    }

    // Statistics
    if (stats.totalRuns > 0) {
      html += '<details class="overview-details">';
      html += '<summary class="overview-summary">Statistics</summary>';
      html += '<div class="overview-details-body">';
      html += '<div class="status-grid">';
      
      html += `
        <div class="stat-card">
          <div class="stat-label">Total Runs</div>
          <div class="stat-value">${stats.totalRuns}</div>
        </div>
      `;

      html += `
        <div class="stat-card">
          <div class="stat-label">Success Rate</div>
          <div class="stat-value">${stats.successRate.toFixed(1)}%</div>
        </div>
      `;

      html += `
        <div class="stat-card">
          <div class="stat-label">Avg Duration</div>
          <div class="stat-value text-sm">${formatDuration(stats.avgDurationMs)}</div>
        </div>
      `;

      if (stats.totalCleanupDeleted > 0) {
        html += `
          <div class="stat-card">
            <div class="stat-label">Total Cleaned</div>
            <div class="stat-value">${stats.totalCleanupDeleted}</div>
          </div>
        `;
      }

      html += '</div></div></details>';
    }

    // Recent History
    if (data.runHistory && data.runHistory.length > 0) {
      html += '<details class="overview-details">';
      html += '<summary class="overview-summary">Recent History</summary>';
      html += '<div class="overview-details-body">';
      html += '<div class="space-y-2">';
      
      // Show last 5 runs
      const recentRuns = data.runHistory.slice(-5).reverse();
      for (const run of recentRuns) {
        const runDate = new Date(run.timestamp);
        html += `
          <div class="flex items-center justify-between p-2 bg-slate-900 rounded border-l-2 ${run.success ? 'border-green-500' : 'border-red-500'}">
            <div class="flex items-center gap-3">
              <span class="text-xs text-slate-500">${runDate.toLocaleTimeString()}</span>
              <span class="status-badge ${run.success ? 'status-success' : 'status-error'}" style="font-size: 0.7rem; padding: 2px 6px;">
                ${run.success ? 'Success' : 'Failed'}
              </span>
            </div>
            <div class="text-xs text-slate-400">${formatDuration(run.duration)}</div>
          </div>
        `;
      }
      
      html += '</div></div></details>';
    }

    element.innerHTML = html;
  } catch (error) {
    element.innerHTML = `
      <div class="text-red-400 text-center py-4">
        <p>Failed to load ingestion status: ${error.message}</p>
      </div>
    `;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

