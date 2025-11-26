import type { ToolSession } from "../../agent/tool-policy";
import type { BaseTool } from "../../tools/BaseTool";
import { executeToolCall } from "../../agent/tool-executor";

function formatVmList(
  title: string,
  vms: Array<{ name?: string; id?: string; state?: string; nodeName?: string; agentAvailable?: boolean }>
): string {
  if (!vms.length) {
    return `${title}\n- None`;
  }

  const lines = [title];
  for (const vm of vms) {
    const parts = [
      vm.name || vm.id || "Unnamed VM",
      vm.nodeName ? `node=${vm.nodeName}` : null,
      vm.state ? `state=${vm.state}` : null,
      vm.agentAvailable !== undefined ? `agent=${vm.agentAvailable ? "available" : "missing"}` : null,
    ].filter(Boolean);
    lines.push(`- ${parts.join(" | ")}`);
  }
  return lines.join("\n");
}

export async function describeClusterChain(tools: BaseTool[], session: ToolSession): Promise<string> {
  const result = await executeToolCall(
    { toolName: "twin_query", parameters: { operation: "describe_cluster" } },
    tools,
    session
  );

  if (result.error) {
    throw new Error(result.error);
  }

  const payload = result.data as any;
  const nodes = payload?.data?.nodes ?? [];
  const vms = payload?.data?.vms ?? [];

  const nodeLines = ["Cluster Nodes:"];
  if (!nodes.length) {
    nodeLines.push("- None discovered in twin");
  } else {
    for (const node of nodes) {
      nodeLines.push(`- ${node.name} (id=${node.id}, vms=${node.vmCount}, status=${node.status ?? "unknown"})`);
    }
  }

  const vmLines = formatVmList("Cluster VMs:", vms);

  return `${nodeLines.join("\n")}\n\n${vmLines}`;
}

export async function listVmsByNodeChain(
  tools: BaseTool[],
  session: ToolSession,
  nodeName: string
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: { operation: "vms_by_node", params: { nodeName } },
    },
    tools,
    session
  );

  if (result.error) {
    throw new Error(result.error);
  }

  const payload = result.data as any;
  const vms = payload?.data ?? [];
  return formatVmList(`VMs on node ${nodeName}:`, vms);
}

export async function listVmsWithoutAgentChain(tools: BaseTool[], session: ToolSession): Promise<string> {
  const result = await executeToolCall(
    { toolName: "twin_query", parameters: { operation: "vms_without_agent" } },
    tools,
    session
  );

  if (result.error) {
    throw new Error(result.error);
  }

  const payload = result.data as any;
  const vms = payload?.data ?? [];
  return formatVmList("VMs without guest agent data:", vms);
}

export async function listStoppedVmsChain(
  tools: BaseTool[],
  session: ToolSession,
  nodeName: string
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: { operation: "stopped_vms_on_node", params: { nodeName } },
    },
    tools,
    session
  );

  if (result.error) {
    throw new Error(result.error);
  }

  const payload = result.data as any;
  const vms = payload?.data ?? [];
  return formatVmList(`Stopped VMs on ${nodeName}:`, vms);
}

