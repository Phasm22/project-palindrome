import { API_URL, escapeHtml, renderResponsiveTable } from './utils.js';
import { createSkeletonStatsGrid } from './skeletons.js';

let overviewRefreshPromise = null;
let overviewLastUpdated = null;

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
    return seconds < 10 ? `${seconds.toFixed(2)}s` : `${seconds.toFixed(1)}s`;
  }

  return `${Math.round(ms)}ms`;
}

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

  if (diffSeconds < 60) return diffSeconds <= 0 ? 'just now' : `${diffSeconds}s ago`;
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffWeeks < 4) return `${diffWeeks}w ago`;
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  return `${diffYears}y ago`;
}

function formatAbsolute(dateString) {
  if (!dateString) return 'Never';
  const date = new Date(dateString);
  return isNaN(date.getTime()) ? 'Invalid date' : date.toLocaleString();
}

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '0';
}

function statusTone(ok, warning = false) {
  if (ok) return 'status-success';
  return warning ? 'status-warning' : 'status-error';
}

function chip(label, value, tone = 'status-neutral') {
  return `
    <span class="status-badge status-badge-dense ${tone}">
      ${label ? `<span class="status-chip-label">${escapeHtml(label)}</span>` : ''}
      ${escapeHtml(value)}
    </span>
  `;
}

function metric(label, value, detail = '') {
  return `
    <div class="metric-card">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(String(value))}</div>
      ${detail ? `<div class="metric-detail">${escapeHtml(detail)}</div>` : ''}
    </div>
  `;
}

function sourceRunRow(name, source, entityLabel = 'entities') {
  if (!source) return '';
  const success = source.success !== false;
  const count = source.entities ?? source.rules;
  return `
    <div class="source-row">
      <div class="source-row-main">
        ${chip(name, success ? 'OK' : 'Failed', success ? 'status-success' : 'status-error')}
        ${count !== undefined ? `<span class="source-row-meta">${formatNumber(count)} ${escapeHtml(entityLabel)}</span>` : ''}
      </div>
      <span class="source-row-duration">${escapeHtml(formatDuration(source.duration || 0))}</span>
    </div>
    ${source.error ? `<div class="source-row-error">${escapeHtml(String(source.error))}</div>` : ''}
  `;
}

async function fetchEndpoint(key, path) {
  try {
    const response = await fetch(`${API_URL}${path}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return { key, ok: true, data: await response.json() };
  } catch (error) {
    return { key, ok: false, error };
  }
}

function normalizeResults(results) {
  return results.reduce((acc, result) => {
    acc[result.key] = result;
    return acc;
  }, {});
}

function getUpstreamHealthDetails(health) {
  if (!health?.upstream || typeof health.upstream !== 'object') return {};
  if (health.upstream.data && typeof health.upstream.data === 'object') return health.upstream.data;
  return health.upstream;
}

function getDependencyEntries(health) {
  const dependencies = health?.dependencies || getUpstreamHealthDetails(health).dependencies || {};
  if (Array.isArray(dependencies)) {
    return dependencies.map((dependency, index) => [
      dependency?.name || `dependency ${index + 1}`,
      dependency,
    ]);
  }
  return Object.entries(dependencies);
}

function buildIssues(data) {
  const issues = [];
  const stats = data.stats.ok ? data.stats.data : {};
  const cluster = data.cluster.ok ? data.cluster.data : {};
  const health = data.health.ok ? data.health.data : {};
  const ingestion = data.ingestion.ok ? data.ingestion.data : {};

  for (const [label, result] of Object.entries({
    'Execution statistics': data.stats,
    'Cluster status': data.cluster,
    'PCE API health': data.health,
    'Ingestion status': data.ingestion,
  })) {
    if (!result.ok) {
      issues.push({
        tone: 'error',
        title: `${label} unavailable`,
        detail: result.error?.message || 'Endpoint did not return data.',
      });
    }
  }

  if (data.health.ok && health.healthy === false) {
    issues.push({
      tone: 'error',
      title: 'PCE API unavailable',
      detail: health.error
        || (health.upstreamStatus ? `Health check returned HTTP ${health.upstreamStatus}.` : 'Dashboard could not reach the PCE API health endpoint.'),
    });
  }

  const dependencies = getDependencyEntries(health);
  for (const [name, dependency] of dependencies) {
    if (dependency && dependency.healthy === false) {
      issues.push({
        tone: 'error',
        title: `${name} dependency unhealthy`,
        detail: dependency.message || dependency.error || 'Health check reported unhealthy.',
      });
    }
  }

  const offlineNodes = cluster.nodes?.offline || 0;
  if (offlineNodes > 0) {
    issues.push({
      tone: 'error',
      title: `${offlineNodes} node${offlineNodes === 1 ? '' : 's'} offline`,
      detail: 'Cluster inventory contains offline Proxmox nodes.',
    });
  }

  if (data.ingestion.ok && ingestion.active === false) {
    issues.push({
      tone: 'warning',
      title: 'Ingestion scheduler inactive',
      detail: 'Inventory freshness may drift until the scheduler is started.',
    });
  }

  const lastRun = ingestion.lastRunDetails;
  if (lastRun && lastRun.success === false) {
    issues.push({
      tone: 'error',
      title: 'Last ingestion run failed',
      detail: formatAbsolute(lastRun.timestamp),
    });
  }

  const recentErrors = stats.recentErrors || [];
  if (recentErrors.length > 0) {
    issues.push({
      tone: 'warning',
      title: `${recentErrors.length} recent tool failure${recentErrors.length === 1 ? '' : 's'}`,
      detail: stats.window === '7d' ? 'Reported in the last 7 days.' : 'Reported by execution telemetry.',
    });
  }

  return issues;
}

function buildVerdict(issues) {
  if (issues.some((issue) => issue.tone === 'error')) return { label: 'Needs attention', tone: 'status-error' };
  if (issues.some((issue) => issue.tone === 'warning')) return { label: 'Watch', tone: 'status-warning' };
  return { label: 'Operational', tone: 'status-success' };
}

function renderSystemSummary(data, issues) {
  const statsOk = data.stats.ok;
  const clusterOk = data.cluster.ok;
  const healthOk = data.health.ok && data.health.data?.healthy !== false;
  const ingestionOk = data.ingestion.ok;
  const health = data.health.ok ? data.health.data : {};
  const cluster = clusterOk ? data.cluster.data : {};
  const ingestion = ingestionOk ? data.ingestion.data : {};
  const dependencies = getDependencyEntries(health);
  const unhealthyDependencies = dependencies.filter(([_, status]) => status?.healthy === false).length;
  const verdict = buildVerdict(issues);

  const ingestionLabel = !ingestionOk
    ? 'Unavailable'
    : ingestion.isRunning
      ? 'Running'
      : ingestion.active
        ? 'Active'
        : 'Inactive';
  const ingestionTone = !ingestionOk || ingestion.active === false
    ? 'status-error'
    : ingestion.isRunning
      ? 'status-warning'
      : 'status-success';

  return `
    <section id="overview-summary-section" class="operational-panel system-summary-panel">
      <div class="panel-heading">
        <div>
          <h2>System Summary</h2>
          <p>Current operational state across API health, dependencies, ingestion, and inventory.</p>
        </div>
        <button class="refresh-button quiet-action" onclick="window.loadOverviewDashboard(true)">
          <span id="refresh-icon-ingestion"></span>
          Refresh
        </button>
      </div>
      <div class="summary-verdict-row">
        <span class="status-badge status-badge-verdict ${verdict.tone}">${verdict.label}</span>
        <span class="last-updated">Last updated ${overviewLastUpdated ? overviewLastUpdated.toLocaleString() : 'Never'}</span>
      </div>
      <div class="status-chip-row">
        ${chip('PCE API', healthOk ? 'Reachable' : 'Unavailable', healthOk ? 'status-success' : 'status-error')}
        ${chip('Dependencies', dependencies.length === 0 ? 'None configured' : `${dependencies.length - unhealthyDependencies}/${dependencies.length} healthy`, unhealthyDependencies > 0 ? 'status-error' : 'status-success')}
        ${chip('Ingestion', ingestionLabel, ingestionTone)}
        ${chip('Cluster', clusterOk ? `${cluster.nodes?.online || 0}/${cluster.nodes?.total || 0} nodes online` : 'Unavailable', clusterOk && (cluster.nodes?.offline || 0) === 0 ? 'status-success' : 'status-error')}
        ${chip('Executions', statsOk ? 'Telemetry ready' : 'Unavailable', statsOk ? 'status-success' : 'status-error')}
      </div>
    </section>
  `;
}

function renderAttention(issues) {
  return `
    <section id="overview-attention-section" class="operational-panel">
      <div class="panel-heading compact">
        <h2>Attention</h2>
      </div>
      <div class="issue-list">
        ${issues.length === 0 ? `
          <div class="issue-row issue-row-success">
            <span class="issue-severity">OK</span>
            <div>
              <div class="issue-title">No active issues</div>
              <div class="issue-detail">All available dashboard signals are currently clean.</div>
            </div>
          </div>
        ` : issues.map((issue) => `
          <div class="issue-row issue-row-${issue.tone}">
            <span class="issue-severity">${issue.tone === 'error' ? 'Action' : 'Watch'}</span>
            <div>
              <div class="issue-title">${escapeHtml(issue.title)}</div>
              <div class="issue-detail">${escapeHtml(issue.detail)}</div>
            </div>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function renderOperatingMetrics(data) {
  const stats = data.stats.ok ? data.stats.data : {};
  const cluster = data.cluster.ok ? data.cluster.data : {};
  const ingestion = data.ingestion.ok ? data.ingestion.data : {};
  const statsWindow = stats.window === '7d' ? 'last 7 days' : 'all time';
  const lastRun = ingestion.lastRunDetails;

  return `
    <section id="overview-metrics-section" class="operational-panel">
      <div class="panel-heading compact">
        <h2>Operating Metrics</h2>
      </div>
      <div class="metric-grid">
        ${metric('Executions', formatNumber(stats.total || 0), statsWindow)}
        ${metric('Error rate', `${(((stats.errorRate || 0) * 100)).toFixed(1)}%`, stats.recentErrors?.length ? `${stats.recentErrors.length} recent failures` : 'no recent failures')}
        ${metric('Avg duration', formatDuration(stats.avgDurationMs || 0), 'tool execution')}
        ${metric('Nodes', formatNumber(cluster.nodes?.total || 0), `${cluster.nodes?.online || 0} online, ${cluster.nodes?.offline || 0} offline`)}
        ${metric('VMs', formatNumber(cluster.vms?.total || 0), `${cluster.vms?.running || 0} running, ${cluster.vms?.stopped || 0} stopped`)}
        ${metric('LXCs', formatNumber(cluster.lxc?.total || 0), `${cluster.lxc?.running || 0} running, ${cluster.lxc?.stopped || 0} stopped`)}
        ${metric('Ingestion freshness', lastRun ? formatRelativeTime(lastRun.timestamp) : 'Never', lastRun ? formatAbsolute(lastRun.timestamp) : 'no run recorded')}
      </div>
    </section>
  `;
}

function renderFreshness(data) {
  const ingestion = data.ingestion.ok ? data.ingestion.data : {};
  const stats = ingestion.statistics || {};
  const lastRun = ingestion.lastRunDetails;
  const nextRunDate = ingestion.nextRun ? new Date(ingestion.nextRun) : null;
  const timeUntilNext = nextRunDate && !isNaN(nextRunDate.getTime())
    ? Math.max(0, Math.floor((nextRunDate - new Date()) / 1000 / 60))
    : null;

  return `
    <section id="overview-ingestion-section" class="operational-panel">
      <div class="panel-heading compact">
        <div>
          <h2>Freshness & Ingestion</h2>
          <p>Scheduler state and source-level outcome from the latest inventory refresh.</p>
        </div>
      </div>
      <div class="metric-grid metric-grid-compact">
        ${metric('Scheduler', ingestion.active ? 'Active' : 'Inactive', ingestion.isRunning ? 'run in progress' : 'idle')}
        ${metric('Current run', ingestion.isRunning ? 'Running' : 'Idle', '')}
        ${metric('Last run', lastRun ? formatRelativeTime(lastRun.timestamp) : 'Never', lastRun ? (lastRun.success ? 'success' : 'failed') : 'no history')}
        ${metric('Next run', timeUntilNext === null ? 'Not scheduled' : timeUntilNext > 0 ? `in ${timeUntilNext}m` : 'due now', nextRunDate ? nextRunDate.toLocaleString() : '')}
        ${metric('Run success', stats.totalRuns > 0 ? `${(stats.successRate || 0).toFixed(1)}%` : 'N/A', `${stats.totalRuns || 0} total runs`)}
      </div>
      ${lastRun ? `
        <div class="source-breakdown">
          ${sourceRunRow('Proxmox', lastRun.proxmox)}
          ${sourceRunRow('Network', lastRun.network)}
          ${sourceRunRow('Firewall', lastRun.firewall, 'rules')}
          ${lastRun.temperature ? `
            <div class="source-row">
              <div class="source-row-main">
                ${chip('Temperature', 'Reported', 'status-neutral')}
                <span class="source-row-meta">${formatNumber(lastRun.temperature.nodesWithTemp || 0)} with data, ${formatNumber(lastRun.temperature.nodesWithoutTemp || 0)} without</span>
              </div>
            </div>
          ` : ''}
          ${lastRun.cleanup?.deleted > 0 ? `
            <div class="source-row">
              <div class="source-row-main">
                ${chip('Cleanup', 'Completed', 'status-neutral')}
                <span class="source-row-meta">Deleted ${formatNumber(lastRun.cleanup.deleted)} stale entities</span>
              </div>
              <span class="source-row-duration">${escapeHtml(formatDuration(lastRun.cleanup.duration || 0))}</span>
            </div>
          ` : ''}
        </div>
      ` : `<div class="empty-row">No ingestion run details available.</div>`}
    </section>
  `;
}

function renderRecentFailures(data) {
  const stats = data.stats.ok ? data.stats.data : {};
  const recentErrors = stats.recentErrors || [];
  const ingestion = data.ingestion.ok ? data.ingestion.data : {};
  const sourceErrors = [];
  const lastRun = ingestion.lastRunDetails;

  if (lastRun) {
    for (const [name, source] of Object.entries({
      Proxmox: lastRun.proxmox,
      Network: lastRun.network,
      Firewall: lastRun.firewall,
    })) {
      if (source?.error) {
        sourceErrors.push({
          type: 'Ingestion',
          source: name,
          error: source.error,
          timestamp: lastRun.timestamp,
        });
      }
    }
  }

  if (recentErrors.length === 0 && sourceErrors.length === 0) return '';

  const rows = [
    ...sourceErrors,
    ...recentErrors.map((error) => ({
      type: 'Tool',
      source: error.toolName || 'Unknown',
      error: error.error || 'Unknown error',
      timestamp: error.timestamp,
      user: error.userId || 'Unknown',
    })),
  ];

  return `
    <section id="overview-failures-section" class="operational-panel">
      <div class="panel-heading compact">
        <h2>Recent Failures</h2>
      </div>
      ${renderResponsiveTable(
        ['Type', 'Source', 'Error', 'Time'],
        rows.slice(0, 12),
        (row) => `
          <td class="whitespace-nowrap">${escapeHtml(row.type)}</td>
          <td class="whitespace-nowrap">${escapeHtml(String(row.source).split('\n')[0])}</td>
          <td class="max-w-md truncate" title="${escapeHtml(String(row.error))}">${escapeHtml(String(row.error).split('\n')[0])}</td>
          <td class="whitespace-nowrap" title="${escapeHtml(formatAbsolute(row.timestamp))}">${escapeHtml(formatRelativeTime(row.timestamp))}</td>
        `
      )}
    </section>
  `;
}

function renderInventory(data) {
  const cluster = data.cluster.ok ? data.cluster.data : {};
  const nodes = cluster.nodes?.list || [];
  const resources = [
    ...(cluster.vms?.resources || []).map((item) => ({ ...item, kind: 'VM' })),
    ...(cluster.lxc?.resources || []).map((item) => ({ ...item, kind: 'LXC' })),
  ].slice(0, 24);

  if (nodes.length === 0 && resources.length === 0) return '';

  return `
    <section id="overview-inventory-section" class="operational-panel">
      <div class="panel-heading compact">
        <h2>Inventory Snapshot</h2>
      </div>
      ${nodes.length > 0 ? `
        <details class="dashboard-details" open>
          <summary>Nodes (${nodes.length})</summary>
          ${renderResponsiveTable(
            ['Node', 'Status', 'CPU', 'Memory', 'Uptime'],
            nodes,
            (node) => `
              <td class="whitespace-nowrap">${escapeHtml(node.name || 'Unknown')}</td>
              <td>${chip('', node.status || 'unknown', node.status === 'online' ? 'status-success' : 'status-error')}</td>
              <td class="whitespace-nowrap">${node.cpu ? escapeHtml(`${(node.cpu * 100).toFixed(1)}%`) : 'N/A'}</td>
              <td class="whitespace-nowrap">${node.memory ? escapeHtml(formatBytes(node.memory)) : 'N/A'}</td>
              <td class="whitespace-nowrap">${node.uptime ? escapeHtml(formatUptime(node.uptime)) : 'N/A'}</td>
            `
          )}
        </details>
      ` : ''}
      ${resources.length > 0 ? `
        <details class="dashboard-details" ${nodes.length === 0 ? 'open' : ''}>
          <summary>VMs & LXCs (${resources.length})</summary>
          ${renderResponsiveTable(
            ['Name', 'Node', 'Status', 'Kind'],
            resources,
            (resource) => `
              <td class="whitespace-nowrap">${escapeHtml(String(resource.name || resource.id || 'Unknown').split('\n')[0])}</td>
              <td class="whitespace-nowrap">${escapeHtml(String(resource.node || 'N/A').split('\n')[0])}</td>
              <td>${chip('', resource.status || 'unknown', resource.status === 'running' ? 'status-success' : resource.status === 'stopped' ? 'status-neutral' : 'status-warning')}</td>
              <td class="whitespace-nowrap">${escapeHtml(resource.kind || resource.type || 'N/A')}</td>
            `
          )}
        </details>
      ` : ''}
    </section>
  `;
}

function renderDiagnostics(data) {
  const raw = {
    executionStats: data.stats.ok ? data.stats.data : { error: data.stats.error?.message },
    clusterStatus: data.cluster.ok ? data.cluster.data : { error: data.cluster.error?.message },
    pceApiHealth: data.health.ok ? data.health.data : { error: data.health.error?.message },
    ingestionStatus: data.ingestion.ok ? data.ingestion.data : { error: data.ingestion.error?.message },
  };

  return `
    <details class="dashboard-details diagnostics-block">
      <summary>Diagnostics JSON</summary>
      <pre class="json-block">${escapeHtml(JSON.stringify(raw, null, 2))}</pre>
    </details>
  `;
}

function renderOverview(data) {
  const issues = buildIssues(data);
  return `
    ${renderSystemSummary(data, issues)}
    ${renderAttention(issues)}
    ${renderOperatingMetrics(data)}
    ${renderFreshness(data)}
    ${renderRecentFailures(data)}
    ${renderInventory(data)}
    ${renderDiagnostics(data)}
  `;
}

function beginOverviewRefresh(element) {
  const hadContent = element.dataset.loaded === 'true' && element.innerHTML.trim().length > 0;
  element.setAttribute('aria-busy', 'true');

  if (!hadContent) {
    element.innerHTML = '';
    element.appendChild(createSkeletonStatsGrid(6));
    return;
  }

  const prevHeight = element.offsetHeight || 0;
  if (prevHeight > 0) element.style.minHeight = `${prevHeight}px`;
  element.style.transition = 'opacity 120ms ease';
  element.style.opacity = '0.75';
}

function endOverviewRefresh(element) {
  element.dataset.loaded = 'true';
  element.removeAttribute('aria-busy');
  element.style.opacity = '';
  element.style.minHeight = '';
  element.style.transition = '';
}

function getOverviewElement() {
  return document.getElementById('overview-dashboard')
    || document.getElementById('execution-stats')
    || document.getElementById('cluster-status')
    || document.getElementById('system-health')
    || document.getElementById('ingestion-status');
}

export async function loadOverviewDashboard(force = false) {
  const element = getOverviewElement();
  if (!element) return;

  if (overviewRefreshPromise && !force) return overviewRefreshPromise;

  beginOverviewRefresh(element);
  overviewRefreshPromise = (async () => {
    const results = await Promise.all([
      fetchEndpoint('stats', '/api/dashboard/execution-stats'),
      fetchEndpoint('cluster', '/api/dashboard/cluster-status'),
      fetchEndpoint('health', '/api/pce-health'),
      fetchEndpoint('ingestion', '/api/dashboard/ingestion-status'),
    ]);
    overviewLastUpdated = new Date();
    element.innerHTML = renderOverview(normalizeResults(results));
    endOverviewRefresh(element);
  })().catch((error) => {
    element.innerHTML = `<div class="error">Failed to load overview: ${escapeHtml(error.message)}</div>`;
    endOverviewRefresh(element);
  }).finally(() => {
    overviewRefreshPromise = null;
  });

  return overviewRefreshPromise;
}

function formatBytes(bytes) {
  if (!bytes) return 'N/A';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

function formatUptime(seconds) {
  if (!seconds) return 'N/A';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function loadExecutionStats() {
  return loadOverviewDashboard();
}

export function loadClusterStatus() {
  return loadOverviewDashboard();
}

export function loadSystemHealth() {
  return loadOverviewDashboard();
}

export function loadIngestionStatus(reset = false) {
  return loadOverviewDashboard(reset);
}

window.loadOverviewDashboard = loadOverviewDashboard;
