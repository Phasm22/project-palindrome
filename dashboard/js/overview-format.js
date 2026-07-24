/**
 * Pure formatting helpers for the Overview dashboard.
 * Kept free of DOM / window imports so unit tests can load them under Bun.
 */

function formatNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : "0";
}

export function coerceMemoryBytes(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "object") {
    if (typeof value.raw === "number" && Number.isFinite(value.raw) && value.raw >= 0) {
      return value.raw;
    }
  }
  return null;
}

export function formatErrorRateDetail(stats) {
  const errorCount = Number.isFinite(Number(stats?.errorCount))
    ? Number(stats.errorCount)
    : (stats?.recentErrors?.length || 0);
  if (errorCount <= 0) return "no failures in window";
  return `${formatNumber(errorCount)} failures in window`;
}

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes)) || Number(bytes) < 0) return "N/A";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(bytes);
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

export function formatNodeMemory(node) {
  const used = coerceMemoryBytes(node?.memory);
  const total = coerceMemoryBytes(node?.maxMemory);
  if (used == null && total == null) return "N/A";
  if (used != null && total != null) return `${formatBytes(used)} / ${formatBytes(total)}`;
  return formatBytes(used ?? total);
}

export function formatUptime(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) return "N/A";
  const total = Number(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
