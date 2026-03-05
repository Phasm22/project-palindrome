import type { BaseTool } from "../../tools/BaseTool";
import type { ToolSession } from "../../agent/tool-policy";
import { executeToolCall } from "../../agent/tool-executor";
import { IngestionSummaryStore, type ExposureSnapshotEntry } from "../../pce/api/ingestion-summary-store";
import { ipInCidr } from "../../parsers/network/network-utils";

function formatInterfaceList(
  title: string,
  interfaces: Array<{
    id: string;
    name: string;
    nodeName?: string;
    status?: string;
    vlan?: string;
    primaryIp?: string;
    vmId?: string;
    labelLine?: string;
  }>
): string {
  if (!interfaces.length) {
    return `${title}\n- None`;
  }

  const lines = [title];
  for (const iface of interfaces) {
    if (iface.labelLine) {
      lines.push(`- ${iface.labelLine}`);
    } else {
      const parts = [
        iface.name,
        iface.nodeName ? `node=${iface.nodeName}` : null,
        iface.status ? `status=${iface.status}` : null,
        iface.primaryIp ? `ip=${iface.primaryIp}` : null,
        iface.vlan ? `vlan=${iface.vlan}` : null,
        iface.vmId ? `vm=${iface.vmId}` : null,
      ].filter(Boolean);
      lines.push(`- ${parts.join(" | ")}`);
    }
  }
  return lines.join("\n");
}

async function loadLatestExposureSnapshot(): Promise<{ createdAt?: Date; entries: ExposureSnapshotEntry[] }> {
  const store = new IngestionSummaryStore();
  try {
    const summary = await store.getLatestSummary();
    return {
      createdAt: summary?.createdAt,
      entries: summary?.snapshot ?? [],
    };
  } finally {
    store.close();
  }
}

function formatVmNetworks(vmName: string, entries: ExposureSnapshotEntry[], createdAt?: Date): string {
  if (!entries.length) {
    return `No network exposure data found for ${vmName}.`;
  }
  const lines = [`Networks for ${vmName}:`];
  if (createdAt) {
    lines.push(`Snapshot: ${createdAt.toISOString()}`);
  }
  for (const entry of entries) {
    const parts = [
      `subnet=${entry.subnet}`,
      entry.allowedBy.length ? `allowedBy=${entry.allowedBy.length}` : null,
      entry.blockedBy.length ? `blockedBy=${entry.blockedBy.length}` : null,
    ].filter(Boolean);
    lines.push(`- ${parts.join(" | ")}`);
  }
  return lines.join("\n");
}

function formatVmMatchesByIp(ip: string, entries: ExposureSnapshotEntry[], createdAt?: Date): string {
  if (!entries.length) {
    return `No VMs found with IP ${ip} in the latest ingestion snapshot.`;
  }
  const lines = [`VMs with IP ${ip}:`];
  if (createdAt) {
    lines.push(`Snapshot: ${createdAt.toISOString()}`);
  }
  for (const entry of entries) {
    lines.push(`- ${entry.vmName} (${entry.vmId}) subnet=${entry.subnet}`);
  }
  return lines.join("\n");
}

function formatMultiNicVms(
  entries: Array<{ vmName: string; vmId: string; subnets: string[] }>,
  createdAt?: Date
): string {
  if (!entries.length) {
    return "No multi-interface VMs found in the latest ingestion snapshot.";
  }
  const lines = ["VMs with multiple interfaces:"];
  if (createdAt) {
    lines.push(`Snapshot: ${createdAt.toISOString()}`);
  }
  for (const entry of entries) {
    lines.push(`- ${entry.vmName} (${entry.vmId}) interfaces=${entry.subnets.length}`);
    for (const subnet of entry.subnets) {
      lines.push(`  - ${subnet}`);
    }
  }
  return lines.join("\n");
}

export async function describeNetworkChain(tools: BaseTool[], session: ToolSession): Promise<string> {
  const result = await executeToolCall(
    { toolName: "twin_query", parameters: { operation: "network_list_interfaces" } },
    tools,
    session
  );
  if (result.error) {
    throw new Error(result.error);
  }
  const payload = result.data as any;
  const interfaces = payload?.data ?? [];
  return formatInterfaceList("Network Interfaces:", interfaces);
}

export async function listNodeInterfacesChain(
  tools: BaseTool[],
  session: ToolSession,
  nodeName: string
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: { operation: "network_interfaces_by_node", params: { nodeName } },
    },
    tools,
    session
  );
  if (result.error) {
    throw new Error(result.error);
  }
  const payload = result.data as any;
  const interfaces = payload?.data ?? [];
  return formatInterfaceList(`Interfaces on ${nodeName}:`, interfaces);
}

export async function vmsBySubnetChain(
  tools: BaseTool[],
  session: ToolSession,
  subnet: string
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: { operation: "network_vms_by_subnet", params: { subnet } },
    },
    tools,
    session
  );
  if (result.error) {
    throw new Error(result.error);
  }
  const payload = result.data as any;
  const vms = payload?.data ?? [];
  if (!vms.length) {
    return `No VMs found on subnet ${subnet}.`;
  }
  const lines = [`VMs on subnet ${subnet}:`];
  for (const vm of vms) {
    lines.push(`- ${vm.vmName} (${vm.vmId}) node=${vm.nodeName ?? "unknown"}`);
  }
  return lines.join("\n");
}

export async function reachabilityChain(
  tools: BaseTool[],
  session: ToolSession,
  fromId: string
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: { operation: "network_reachability", params: { fromId } },
    },
    tools,
    session
  );
  if (result.error) {
    throw new Error(result.error);
  }
  const payload = result.data as any;
  const targets = payload?.data ?? [];
  if (!targets.length) {
    return `No reachable entities found from ${fromId}.`;
  }
  const lines = [`Entities sharing a subnet with ${fromId}:`];
  for (const target of targets) {
    lines.push(`- ${target.name} (${target.id}) via ${target.viaSubnet}`);
  }
  return lines.join("\n");
}

export async function vmReachabilityChain(
  vmId: string,
  tools: BaseTool[],
  session: ToolSession
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: { operation: "vm_reachability_summary", params: { vmId } },
    },
    tools,
    session
  );
  if (result.error) {
    throw new Error(result.error);
  }
  const payload = result.data as any;
  const summary = payload?.data;
  if (!summary) {
    return `No reachability data found for VM ${vmId}.`;
  }

  const lines = [`Reachability summary for ${summary.vmName} (${summary.vmId}):`];
  if (summary.nodeName) {
    lines.push(`Node: ${summary.nodeName}`);
  }
  lines.push(`Interfaces: ${summary.interfaces?.length ?? 0}`);
  for (const iface of summary.interfaces ?? []) {
    const parts = [
      iface.interfaceName,
      iface.subnet ? `subnet=${iface.subnet}` : null,
      iface.reachableEntities > 0 ? `${iface.reachableEntities} reachable` : null,
    ].filter(Boolean);
    lines.push(`  - ${parts.join(" | ")}`);
  }
  if (summary.exposedSubnets?.length > 0) {
    lines.push(`Exposed subnets: ${summary.exposedSubnets.join(", ")}`);
  }
  if (summary.allowedBy?.length > 0) {
    lines.push(`Allowed by ${summary.allowedBy.length} firewall rule(s)`);
  }
  if (summary.blockedBy?.length > 0) {
    lines.push(`Blocked by ${summary.blockedBy.length} firewall rule(s)`);
  }
  return lines.join("\n");
}

export async function vmNetworksFromIngestionChain(vmNameOrId: string): Promise<string> {
  const { createdAt, entries } = await loadLatestExposureSnapshot();
  if (!entries.length) {
    return "No ingestion exposure snapshots are available yet.";
  }

  const normalized = vmNameOrId.toLowerCase();
  const matches = entries.filter((entry) =>
    entry.vmId.toLowerCase() === normalized || entry.vmName.toLowerCase() === normalized
  );

  if (!matches.length) {
    const partialMatches = entries.filter((entry) =>
      entry.vmName.toLowerCase().includes(normalized)
    );
    if (partialMatches.length) {
      return formatVmNetworks(vmNameOrId, partialMatches, createdAt);
    }
    return `No network exposure data found for ${vmNameOrId}.`;
  }

  return formatVmNetworks(vmNameOrId, matches, createdAt);
}

export async function vmByIpFromIngestionChain(ip: string): Promise<string> {
  const { createdAt, entries } = await loadLatestExposureSnapshot();
  if (!entries.length) {
    return "No ingestion exposure snapshots are available yet.";
  }

  const matches = entries.filter((entry) => ipInCidr(ip, entry.subnet));
  return formatVmMatchesByIp(ip, matches, createdAt);
}

export async function vmsWithMultipleInterfacesFromIngestionChain(): Promise<string> {
  const { createdAt, entries } = await loadLatestExposureSnapshot();
  if (!entries.length) {
    return "No ingestion exposure snapshots are available yet.";
  }

  const byVm = new Map<string, { vmName: string; vmId: string; subnets: Set<string> }>();
  for (const entry of entries) {
    const existing = byVm.get(entry.vmId) ?? {
      vmName: entry.vmName,
      vmId: entry.vmId,
      subnets: new Set<string>(),
    };
    existing.subnets.add(entry.subnet);
    byVm.set(entry.vmId, existing);
  }

  const multiNic = Array.from(byVm.values())
    .filter((vm) => vm.subnets.size > 1)
    .map((vm) => ({
      vmName: vm.vmName,
      vmId: vm.vmId,
      subnets: Array.from(vm.subnets.values()),
    }));

  return formatMultiNicVms(multiNic, createdAt);
}

/**
 * Resolve VM by name via twin, then get its IP via Proxmox get_vm_ip.
 * Ensures node is passed so we never hit "node parameter required".
 */
export async function vmIpByNameChain(
  vmNameOrId: string,
  tools: BaseTool[],
  session: ToolSession
): Promise<string> {
  const findResult = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: { operation: "find_vm_by_name", params: { vmName: vmNameOrId } },
    },
    tools,
    session
  );
  if (findResult.error) {
    return `Could not find VM "${vmNameOrId}": ${findResult.error}`;
  }
  const payload = findResult.data as {
    kind?: string;
    data?: Array<{ id: string; name?: string; nodeName?: string; vmKind?: string }>;
  };
  const vms = payload?.data ?? [];
  if (!vms.length) {
    return `No VM found with name "${vmNameOrId}".`;
  }
  const first = vms[0];
  if (!first) {
    return `No VM found with name "${vmNameOrId}".`;
  }
  const nodeName = first.nodeName;
  const vmidStr = first.id?.split(":").pop();
  const vmid = vmidStr ? parseInt(vmidStr, 10) : NaN;
  const vmKind = (first as any).vmKind as string | undefined;
  const vmType = vmKind === "lxc" ? "lxc" : "qemu";
  if (!nodeName || Number.isNaN(vmid)) {
    return `Could not resolve node/vmid for "${vmNameOrId}" (id: ${first.id}).`;
  }
  const ipResult = await executeToolCall(
    {
      toolName: "proxmox_readonly",
      parameters: { action: "get_vm_ip", node: nodeName, vmid, type: vmType },
    },
    tools,
    session
  );
  if (ipResult.error) {
    return `VM "${first.name ?? vmNameOrId}" (node=${nodeName}, vmid=${vmid}) found but could not get IP: ${ipResult.error}`;
  }
  const ipPayload = ipResult.data as { ip?: string; ips?: string[]; name?: string; error?: string; message?: string };
  if (ipPayload?.error || ipPayload?.message) {
    return `VM "${first.name ?? vmNameOrId}" (node=${nodeName}): ${ipPayload.message ?? ipPayload.error ?? "no IP available"}.`;
  }
  const ip = ipPayload?.ip ?? ipPayload?.ips?.[0];
  const host = ipPayload?.name ?? first.name ?? vmNameOrId;
  if (!ip) {
    return `VM "${host}" (node=${nodeName}, vmid=${vmid}): no IP reported (guest agent may be unavailable).`;
  }
  return `IP Address | host=${host} | ip=${ip}`;
}
