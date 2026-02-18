/**
 * Authoritative network labels: CIDR -> human-readable name.
 * Loaded from config/network-labels.yaml (or built-in defaults).
 * Used in agent answers for interfaces and VM networking.
 */

import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { ipInCidr } from "../parsers/network/network-utils";

const DEFAULT_LABELS: Record<string, string> = {
  "192.168.68.0/22": "HomeNet",
  "172.16.0.0/22": "LabNet",
};

let cachedMap: Map<string, string> | null = null;

function loadLabelMap(): Map<string, string> {
  if (cachedMap) return cachedMap;
  const configPath = path.join(__dirname, "network-labels.yaml");
  try {
    if (fs.existsSync(configPath)) {
      const raw = parseYaml(fs.readFileSync(configPath, "utf-8")) as Record<string, string> | null;
      if (raw && typeof raw === "object") {
        cachedMap = new Map(Object.entries(raw).filter(([, v]) => typeof v === "string"));
        return cachedMap;
      }
    }
  } catch {
    // fall through to defaults
  }
  cachedMap = new Map(Object.entries(DEFAULT_LABELS));
  return cachedMap;
}

/**
 * Returns the label for a CIDR (e.g. "172.16.0.0/22" -> "LabNet"), or null if not in the map.
 */
export function getNetworkLabel(cidr: string): string | null {
  const normalized = cidr?.trim();
  if (!normalized) return null;
  return loadLabelMap().get(normalized) ?? null;
}

export interface NetworkLabelForIp {
  cidr: string;
  label: string;
}

/**
 * Returns the CIDR and label for an IP (e.g. "172.16.0.100" -> { cidr: "172.16.0.0/22", label: "LabNet" }).
 * Uses first matching CIDR in the map; for overlapping CIDRs, order is undefined.
 */
export function getNetworkLabelForIp(ip: string): NetworkLabelForIp | null {
  const trimmed = ip?.trim();
  if (!trimmed || !trimmed.includes(".")) return null;
  for (const [cidr, label] of loadLabelMap()) {
    if (ipInCidr(trimmed, cidr)) return { cidr, label };
  }
  return null;
}

/**
 * Format a single line for an interface: "net0: HomeNet (192.168.68.0/22) — IP 192.168.68.87"
 * or "net0: IP 192.168.68.87" if no label.
 */
export function formatInterfaceLine(
  interfaceName: string,
  ip: string | undefined | null,
  fallbackCidr?: string | null
): string {
  if (!ip) return interfaceName;
  const info = getNetworkLabelForIp(ip);
  const cidr = info?.cidr ?? fallbackCidr;
  const label = info?.label ?? (cidr ? getNetworkLabel(cidr ?? "") : null);
  if (label && cidr) return `${interfaceName}: ${label} (${cidr}) — IP ${ip}`;
  return `${interfaceName}: IP ${ip}`;
}
