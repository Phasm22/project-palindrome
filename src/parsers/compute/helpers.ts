export function normalizeNodeId(name: string): string {
  return `compute-node:${name.toLowerCase()}`;
}

export function normalizeVmId(node: string, vmid: number | string): string {
  return `compute-vm:${node.toLowerCase()}:${vmid}`;
}

export function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function collectIpAddresses(...values: Array<string | undefined | null>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    trimmed
      .split(/[,\s]+/)
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0)
      .forEach((ip) => set.add(ip));
  }
  return Array.from(set);
}

