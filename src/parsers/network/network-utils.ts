import { collectIpAddresses } from "../compute/helpers";

export function normalizeInterfaceId(nodeName: string, ifaceName: string): string {
  const safeNode = (nodeName || "unknown").toLowerCase();
  const safeIface = (ifaceName || "unnamed").toLowerCase();
  return `network-if:${safeNode}:${safeIface}`;
}

export function normalizeSubnetId(cidr: string): string {
  return `network-subnet:${cidr.toLowerCase()}`;
}

export function parseCidrs(rawValues: Array<string | undefined | null>): string[] {
  const set = new Set<string>();
  for (const value of rawValues) {
    if (!value) continue;
    collectIpAddresses(value)
      .map((ip) => ip.trim())
      .filter((ip) => ip.includes("/"))
      .forEach((cidr) => set.add(cidr));
  }
  return Array.from(set);
}

export function derivePrimaryIp(cidrs: string[]): string | null {
  if (!cidrs.length) {
    return null;
  }
  const ipv4 = cidrs
    .map((cidr) => cidr.split("/")[0] ?? "")
    .filter((ip): ip is string => ip.length > 0 && ip.includes("."))
    .sort((a, b) => (a > b ? 1 : -1));
  return ipv4[0] ?? cidrs[0] ?? null;
}

export function cidrMask(cidr: string): number {
  const parts = cidr.split("/");
  if (parts.length === 2) {
    const mask = Number(parts[1]);
    if (!Number.isNaN(mask)) {
      return mask;
    }
  }
  return 32;
}

/** IPv4 octets to 32-bit integer (big-endian). */
function ipToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const octet = parseInt(p, 10);
    if (Number.isNaN(octet) || octet < 0 || octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

/**
 * Returns true if the given IPv4 address is inside the CIDR range.
 * Handles CIDR strings like "172.16.0.0/22" or "10.0.0.0/8".
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [base = "", maskStr] = cidr.trim().split("/");
  if (!base) return false;
  const prefixLen = maskStr != null ? parseInt(maskStr, 10) : 32;
  if (Number.isNaN(prefixLen) || prefixLen < 0 || prefixLen > 32) return false;
  const ipN = ipToInt(ip);
  const baseN = ipToInt(base);
  if (ipN == null || baseN == null) return false;
  const mask = prefixLen === 0 ? 0 : ~((1 << (32 - prefixLen)) - 1) >>> 0;
  return (ipN & mask) === (baseN & mask);
}

export function safeStatus(value: string | number | undefined | null): "up" | "down" | "unknown" {
  if (value === undefined || value === null) return "unknown";
  if (typeof value === "number") {
    return value > 0 ? "up" : "down";
  }
  const normalized = value.toString().toLowerCase();
  if (["up", "running", "active"].includes(normalized)) return "up";
  if (["down", "inactive", "disabled", "stopped"].includes(normalized)) return "down";
  return "unknown";
}

export function coerceVlan(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const str = value.toString().trim();
  return str.length ? str : null;
}
