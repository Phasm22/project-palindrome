/**
 * Normalization utilities for Proxmox API responses
 * Converts raw Proxmox JSON to clean, LLM-safe, structured JSON
 */

/**
 * Convert bytes to MB or GB (consistent units)
 */
export function normalizeMemory(bytes: number | string | undefined): {
  value: number;
  unit: "MB" | "GB";
  raw: number;
} {
  if (!bytes) {
    return { value: 0, unit: "MB", raw: 0 };
  }

  const bytesNum = typeof bytes === "string" ? parseInt(bytes, 10) : bytes;
  if (isNaN(bytesNum) || bytesNum < 0) {
    return { value: 0, unit: "MB", raw: 0 };
  }

  // Use GB for values >= 1GB, otherwise MB
  if (bytesNum >= 1024 * 1024 * 1024) {
    return {
      value: Math.round((bytesNum / (1024 * 1024 * 1024)) * 100) / 100,
      unit: "GB",
      raw: bytesNum,
    };
  } else {
    return {
      value: Math.round((bytesNum / (1024 * 1024)) * 100) / 100,
      unit: "MB",
      raw: bytesNum,
    };
  }
}

/**
 * Convert Unix timestamp to ISO8601 UTC string
 */
export function normalizeTimestamp(
  timestamp: number | string | undefined
): string | null {
  if (!timestamp) {
    return null;
  }

  const ts = typeof timestamp === "string" ? parseInt(timestamp, 10) : timestamp;
  if (isNaN(ts) || ts <= 0) {
    return null;
  }

  // Handle both seconds and milliseconds
  const date = ts < 10000000000 ? new Date(ts * 1000) : new Date(ts);
  return date.toISOString();
}

/**
 * Normalize status strings to consistent format
 */
export function normalizeStatus(status: string | number | undefined): string {
  // Handle undefined/null explicitly (but allow 0 and "" as valid values)
  if (status === undefined || status === null) {
    return "unknown";
  }

  const statusStr = String(status).toLowerCase().trim();
  
  // Map common status variations
  const statusMap: Record<string, string> = {
    "0": "stopped",
    "1": "running",
    "running": "running",
    "stopped": "stopped",
    "paused": "paused",
    "online": "online",
    "offline": "offline",
    "unknown": "unknown",
  };

  return statusMap[statusStr] || statusStr;
}

/**
 * Normalize boolean values
 */
export function normalizeBoolean(value: any): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim();
    return lower === "true" || lower === "1" || lower === "yes";
  }
  return false;
}

/**
 * Flatten nested Proxmox structures
 * Removes unnecessary nesting and standardizes field names
 */
export function flattenProxmoxObject(obj: any, prefix = ""): Record<string, any> {
  if (obj === null || obj === undefined) {
    return {};
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => flattenProxmoxObject(item, prefix));
  }

  if (typeof obj !== "object") {
    return obj;
  }

  const flattened: Record<string, any> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Skip internal/temporary fields
    if (
      key.startsWith("_") ||
      key === "digest" ||
      key === "csum" ||
      key === "_tmp"
    ) {
      continue;
    }

    const newKey = prefix ? `${prefix}_${key}` : key;

    if (value === null || value === undefined) {
      continue;
    }

    // Preserve normalized fields (they're already in good format)
    if (key.endsWith("_normalized") || key.endsWith("_iso8601")) {
      flattened[newKey] = value;
      continue;
    }

    if (Array.isArray(value)) {
      flattened[newKey] = value.map((item) =>
        typeof item === "object" && item !== null
          ? flattenProxmoxObject(item, newKey)
          : item
      );
    } else if (typeof value === "object") {
      // Flatten nested objects
      Object.assign(flattened, flattenProxmoxObject(value, newKey));
    } else {
      flattened[newKey] = value;
    }
  }

  return flattened;
}

/**
 * Normalize Proxmox API response data
 * Applies all normalization rules to create clean, structured output
 */
export function normalizeProxmoxResponse(
  data: any,
  options: {
    normalizeMemory?: boolean;
    normalizeTimestamps?: boolean;
    flatten?: boolean;
  } = {}
): any {
  const {
    normalizeMemory: doNormalizeMemory = true,
    normalizeTimestamps: doNormalizeTimestamps = true,
    flatten: doFlatten = true,
  } = options;

  if (data === null || data === undefined) {
    return null;
  }

  if (Array.isArray(data)) {
    return data.map((item) => normalizeProxmoxResponse(item, options));
  }

  if (typeof data !== "object") {
    return data;
  }

  let normalized = { ...data };

  // Normalize memory fields
  if (doNormalizeMemory) {
    const memoryFields = ["memory", "maxmem", "mem", "total", "used", "free"];
    for (const field of memoryFields) {
      if (normalized[field] !== undefined) {
        normalized[`${field}_normalized`] = normalizeMemory(normalized[field]);
      }
    }
  }

  // Normalize timestamp fields
  if (doNormalizeTimestamps) {
    const timestampFields = [
      "uptime",
      "time",
      "timestamp",
      "created",
      "modified",
      "starttime",
    ];
    for (const field of timestampFields) {
      if (normalized[field] !== undefined) {
        normalized[`${field}_iso8601`] = normalizeTimestamp(normalized[field]);
      }
    }
  }

  // Normalize status fields
  if (normalized.status !== undefined) {
    normalized.status_normalized = normalizeStatus(normalized.status);
  }

  // Flatten structure
  if (doFlatten) {
    normalized = flattenProxmoxObject(normalized);
  }

  return normalized;
}

