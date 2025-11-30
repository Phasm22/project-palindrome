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
  // Normalize node name (yang -> YANG, yin -> YIN, etc.)
  const normalizedNode = nodeName.charAt(0).toUpperCase() + nodeName.slice(1).toLowerCase();
  // Handle special cases
  const finalNodeName = normalizedNode === "Proxbig" ? "proxBig" : 
                       normalizedNode === "Yang" ? "YANG" :
                       normalizedNode === "Yin" ? "YIN" : normalizedNode;

  // Query for all VM types (qemu and lxc) to get complete list
  const [qemuResult, lxcResult] = await Promise.all([
    executeToolCall(
      {
        toolName: "twin_query",
        parameters: { operation: "vms_by_node", params: { nodeName: finalNodeName, vmKind: "qemu" } },
      },
      tools,
      session
    ),
    executeToolCall(
      {
        toolName: "twin_query",
        parameters: { operation: "vms_by_node", params: { nodeName: finalNodeName, vmKind: "lxc" } },
      },
      tools,
      session
    ),
  ]);

  if (qemuResult.error) {
    throw new Error(qemuResult.error);
  }
  if (lxcResult.error) {
    throw new Error(lxcResult.error);
  }

  const qemuPayload = qemuResult.data as any;
  const lxcPayload = lxcResult.data as any;
  const qemuVms = qemuPayload?.data ?? [];
  const lxcVms = lxcPayload?.data ?? [];
  
  // Combine and sort by VM ID
  const allVms = [...qemuVms, ...lxcVms].sort((a, b) => {
    const aId = a.id ? parseInt(a.id.split(':').pop() || '0') : 0;
    const bId = b.id ? parseInt(b.id.split(':').pop() || '0') : 0;
    return aId - bId;
  });

  // Format response with VM IDs prominently displayed
  const lines = [`VM IDs on node ${finalNodeName}:`];
  if (!allVms.length) {
    lines.push("- No VMs found in the digital twin for this node.");
    lines.push("\nNote: The twin may be incomplete. Run Proxmox ingestion to sync all VMs.");
    return lines.join("\n");
  }

  // Group by VM ID for clarity
  for (const vm of allVms) {
    const label = vm.name || "Unnamed VM";
    const vmId = vm.id ? vm.id.split(':').pop() : "unknown";
    const vmType = vm.vmKind === "lxc" ? "LXC container" : "QEMU VM";
    const state = vm.state ? vm.state : "unknown state";
    lines.push(`- VM ${vmId}: ${label} (${vmType}, ${state})`);
    
    const detailParts = [
      vm.nodeName ? `node=${vm.nodeName}` : null,
      `trace=${vm.id ?? "unknown"}`,
    ].filter(Boolean);
    if (detailParts.length > 0) {
      lines.push(`  - Details: ${detailParts.join(" | ")}`);
    }
  }

  lines.push(
    "\nTip: Use twin_query with the trace ID above to retrieve raw fields for auditing."
  );
  lines.push("Note: If VMs are missing, the digital twin may need to be synced. Run Proxmox ingestion to update.");
  return lines.join("\n");
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

export async function findVmByIdChain(
  tools: BaseTool[],
  session: ToolSession,
  vmId: number
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: { operation: "find_vm_by_id", params: { vmId } },
    },
    tools,
    session
  );

  if (result.error) {
    throw new Error(result.error);
  }

  const payload = result.data as any;
  const vms = payload?.data ?? [];
  const isAmbiguous = payload?.ambiguous === true;

  if (vms.length === 0) {
    return `VM ${vmId} was not found in the digital twin.`;
  }

  // For single VM, return simple format
  if (vms.length === 1) {
    const vm = vms[0];
    const label = vm.name || "Unnamed VM";
    const vmType = vm.vmKind === "lxc" ? "LXC container" : "QEMU VM";
    const state = vm.state ? vm.state : "unknown";
    const nodeInfo = vm.nodeName ? ` on ${vm.nodeName}` : "";
    return `${label} (${vmType}, ${state}${nodeInfo})`;
  }

  // For multiple VMs, show all matches concisely
  const lines: string[] = [];
  lines.push(`VM ${vmId} refers to multiple virtual machines:`);
  
  for (const vm of vms) {
    const label = vm.name || "Unnamed VM";
    const vmType = vm.vmKind === "lxc" ? "LXC container" : "QEMU VM";
    const state = vm.state ? vm.state : "unknown";
    const nodeInfo = vm.nodeName ? ` on ${vm.nodeName}` : "";
    lines.push(`- ${label} (${vmType}, ${state}${nodeInfo})`);
  }
  
  return lines.join("\n");
}

