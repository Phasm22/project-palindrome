import type { BaseTool } from "../../tools/BaseTool";
import type { ToolSession } from "../../agent/tool-policy";
import { executeToolCall } from "../../agent/tool-executor";

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
  }>
): string {
  if (!interfaces.length) {
    return `${title}\n- None`;
  }

  const lines = [title];
  for (const iface of interfaces) {
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

