export interface ResolvedVmEntity {
  name?: string;
  node: string;
  vmid: number;
  type?: "qemu" | "lxc";
}

function asVmType(value: unknown): "qemu" | "lxc" | undefined {
  return value === "qemu" || value === "lxc" ? value : undefined;
}

function parseVmid(value: unknown, id: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (typeof id === "string") {
    const match = id.match(/^compute-vm:[^:]+:(\d+)$/i);
    if (match) return Number(match[1]);
  }
  return undefined;
}

export function extractResolvedVmEntity(
  toolName: string,
  payload: unknown
): ResolvedVmEntity | null {
  if (toolName !== "twin_query" || !payload || typeof payload !== "object") {
    return null;
  }

  const result = payload as Record<string, unknown>;
  const entries = Array.isArray(result.data) ? result.data : [];
  if (entries.length !== 1 || !entries[0] || typeof entries[0] !== "object") {
    return null;
  }

  const entity = entries[0] as Record<string, unknown>;
  const node = entity.nodeName ?? entity.node;
  const vmid = parseVmid(entity.vmid ?? entity.vmId, entity.id);
  if (typeof node !== "string" || !node.trim() || vmid === undefined) {
    return null;
  }

  return {
    name: typeof entity.name === "string" ? entity.name : undefined,
    node: node.trim(),
    vmid,
    type: asVmType(entity.vmKind ?? entity.type),
  };
}

export function hydrateProxmoxReadArgs(
  toolName: string,
  args: Record<string, any>,
  resolvedVm: ResolvedVmEntity | null
): { args: Record<string, any>; hydrated: string[] } {
  if (toolName !== "proxmox_readonly" || !resolvedVm) {
    return { args, hydrated: [] };
  }

  const action = args.action;
  const isVmAction =
    typeof action === "string" &&
    (action.startsWith("get_vm_") || action === "get_lxc_config");
  const isVmTaskQuery = action === "node_tasks";
  if (!isVmAction && !isVmTaskQuery) {
    return { args, hydrated: [] };
  }

  const hydratedArgs = { ...args };
  const hydrated: string[] = [];
  if (!hydratedArgs.node) {
    hydratedArgs.node = resolvedVm.node;
    hydrated.push("node");
  }
  if (hydratedArgs.vmid === undefined || hydratedArgs.vmid === null) {
    hydratedArgs.vmid = resolvedVm.vmid;
    hydrated.push("vmid");
  }
  if (isVmAction && !hydratedArgs.type && resolvedVm.type) {
    hydratedArgs.type = resolvedVm.type;
    hydrated.push("type");
  }

  return { args: hydratedArgs, hydrated };
}
