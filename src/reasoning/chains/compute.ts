import type { ToolSession } from "../../agent/tool-policy";
import type { BaseTool } from "../../tools/BaseTool";
import { executeToolCall } from "../../agent/tool-executor";

function formatVmList(
  title: string,
  vms: Array<{
    name?: string;
    id?: string;
    state?: string;
    nodeName?: string;
    agentAvailable?: boolean;
    vmKind?: "qemu" | "lxc";
  }>
): string {
  const lines = [title];
  if (!vms.length) {
    lines.push("- None discovered in the twin.");
    return lines.join("\n");
  }

  for (const vm of vms) {
    const label = vm.name || vm.id || "Unnamed compute entity";
    const vmType = vm.vmKind === "lxc" ? "LXC container" : "QEMU VM";
    const state = vm.state ? vm.state : "unknown state";
    lines.push(`- ${label} (${vmType}, ${state})`);

    const detailParts = [
      vm.nodeName ? `node=${vm.nodeName}` : null,
      `trace=${vm.id ?? "unknown"}`,
    ].filter(Boolean);
    lines.push(`  - Details: ${detailParts.join(" | ")}`);
    const agentNote =
      vm.agentAvailable === undefined
        ? "agent status unknown"
        : vm.agentAvailable
        ? "guest agent detected"
        : "guest agent missing";
    lines.push(`  - Source: Digital twin (Proxmox ingest); ${agentNote}.`);
  }

  lines.push(
    "Tip: Use twin_query with the trace ID above to retrieve raw fields for auditing."
  );
  return lines.join("\n");
}

export async function describeClusterChain(tools: BaseTool[], session: ToolSession): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: { operation: "describe_cluster", params: { vmKind: "qemu" } },
    },
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
      parameters: { operation: "vms_by_node", params: { nodeName, vmKind: "qemu" } },
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
    {
      toolName: "twin_query",
      parameters: { operation: "vms_without_agent", params: { vmKind: "qemu" } },
    },
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
      parameters: { operation: "stopped_vms_on_node", params: { nodeName, vmKind: "qemu" } },
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

