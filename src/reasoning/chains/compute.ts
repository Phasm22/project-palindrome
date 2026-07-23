import type { ToolSession } from "../../agent/tool-policy";
import type { BaseTool } from "../../tools/BaseTool";
import { executeToolCall } from "../../agent/tool-executor";

/**
 * VM details resolved from cluster resources
 */
export interface ResolvedVmDetails {
  vmid: number;
  node: string;
  name: string;
  type: "qemu" | "lxc";
  status: string;
  found: boolean;
  ambiguous?: boolean;
  matches?: Array<{ vmid: number; node: string; name: string; type: "qemu" | "lxc"; status: string }>;
}

type VmKind = "qemu" | "lxc" | "all";

type VmRecord = {
  name?: string;
  id?: string;
  state?: string;
  nodeName?: string;
  agentAvailable?: boolean;
  vmKind?: "qemu" | "lxc";
};

function getVmKindLabels(vmKind?: VmKind) {
  const kind = vmKind ?? "all";
  if (kind === "lxc") {
    return { listLabel: "LXC containers", noneLabel: "LXC containers" };
  }
  if (kind === "qemu") {
    return { listLabel: "VMs", noneLabel: "VMs" };
  }
  return { listLabel: "VMs and LXC containers", noneLabel: "VMs or LXC containers" };
}

function sortVmsById(vms: VmRecord[]): VmRecord[] {
  return [...vms].sort((a, b) => {
    const aId = a.id ? parseInt(a.id.split(":").pop() || "0", 10) : 0;
    const bId = b.id ? parseInt(b.id.split(":").pop() || "0", 10) : 0;
    return aId - bId;
  });
}

async function fetchVmsByNode(
  tools: BaseTool[],
  session: ToolSession,
  nodeName: string,
  vmKind?: VmKind
): Promise<VmRecord[]> {
  const requestedKind = vmKind ?? "all";
  const requests: Array<Promise<{ kind: "qemu" | "lxc"; result: { error?: string; data?: unknown } }>> = [];

  if (requestedKind !== "lxc") {
    requests.push(
      executeToolCall(
        {
          toolName: "twin_query",
          parameters: { operation: "vms_by_node", params: { nodeName, vmKind: "qemu" } },
        },
        tools,
        session
      ).then((result) => ({ kind: "qemu", result }))
    );
  }

  if (requestedKind !== "qemu") {
    requests.push(
      executeToolCall(
        {
          toolName: "twin_query",
          parameters: { operation: "vms_by_node", params: { nodeName, vmKind: "lxc" } },
        },
        tools,
        session
      ).then((result) => ({ kind: "lxc", result }))
    );
  }

  const results = await Promise.all(requests);
  const qemuVms: VmRecord[] = [];
  const lxcVms: VmRecord[] = [];

  for (const { kind, result } of results) {
    if (result.error) {
      throw new Error(result.error);
    }
    const payload = result.data as { data?: VmRecord[] } | undefined;
    const vms = payload?.data ?? [];
    if (kind === "qemu") {
      qemuVms.push(...vms);
    } else {
      lxcVms.push(...vms);
    }
  }

  return sortVmsById([...qemuVms, ...lxcVms]);
}

/** Derive a short, readable label from twin VM id (e.g. compute-vm:yang:103 → "VM 103") or use name if friendly. */
function vmDisplayLabel(vm: VmRecord): string {
  const kind = vm.vmKind === "lxc" ? "LXC" : "VM";
  const name = vm.name?.trim();
  if (name && name !== vm.id && !name.startsWith("compute-vm:") && !name.startsWith("compute-lxc:")) {
    return name;
  }
  const id = vm.id ?? "";
  const match = id.match(/compute-(?:vm|lxc):[^:]+:(\d+)$/);
  const vmid = match ? match[1] : id.split(":").pop() ?? id;
  return `${kind} ${vmid}`;
}

function formatVmList(
  title: string,
  vms: VmRecord[],
  options: { compact?: boolean } = {}
): string {
  const lines = [title];
  if (!vms.length) {
    lines.push("- None discovered in the twin.");
    return lines.join("\n");
  }

  const compact = options.compact ?? false;
  for (const vm of vms) {
    const label = vmDisplayLabel(vm);
    const vmType = vm.vmKind === "lxc" ? "LXC" : "VM";
    const state = vm.state ?? "unknown";
    const nodePart = vm.nodeName ? ` on ${vm.nodeName}` : "";

    if (compact) {
      const nodeLabel = vm.nodeName ?? "unknown node";
      const tracePart = vm.id ? ` | trace=${vm.id}` : "";
      lines.push(`- ${label} (${nodeLabel}, ${state})${tracePart}`);
    } else {
      lines.push(`- ${label} (${vmType}, ${state})${nodePart}`);
      const detailParts = [
        vm.nodeName ? `node=${vm.nodeName}` : null,
        vm.id ? `trace=${vm.id}` : null,
      ].filter(Boolean);
      if (detailParts.length > 0) {
        lines.push(`  - Details: ${detailParts.join(" | ")}`);
      }
      const agentNote =
        vm.agentAvailable === undefined
          ? "agent status unknown"
          : vm.agentAvailable
          ? "guest agent detected"
          : "guest agent missing";
      lines.push(`  - Source: Digital twin (Proxmox ingest); ${agentNote}.`);
    }
  }

  if (!compact) {
    lines.push(
      "Tip: Use twin_query with the trace ID above to retrieve raw fields for auditing."
    );
  }
  return lines.join("\n");
}

export async function describeClusterChain(tools: BaseTool[], session: ToolSession): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: { operation: "describe_cluster" },
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

  // Per-node VM counts from actual VM list (twin node.vmCount can be stale)
  const vmCountByNode: Record<string, number> = {};
  for (const vm of vms) {
    const n = (vm.nodeName ?? "unknown") as string;
    vmCountByNode[n] = (vmCountByNode[n] ?? 0) + 1;
  }
  const totalVms = vms.length;
  const nodeCount = nodes.length;
  const summaryParts = [
    `Cluster status: ${nodeCount} node${nodeCount === 1 ? "" : "s"}, ${totalVms} VM/LXC total.`,
  ];
  if (Object.keys(vmCountByNode).length > 0) {
    const perNode = Object.entries(vmCountByNode)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([node, count]) => `${node}: ${count}`)
      .join(", ");
    summaryParts.push(`Per node: ${perNode}.`);
  }
  const summary = summaryParts.join(" ");

  const nodeLines = ["Cluster Nodes:"];
  if (!nodes.length) {
    nodeLines.push("- None discovered in twin");
  } else {
    for (const node of nodes) {
      const count = vmCountByNode[node.name ?? node.id ?? ""] ?? node.vmCount ?? 0;
      nodeLines.push(`- ${node.name} (id=${node.id}, vms=${count}, status=${node.status ?? "unknown"})`);
    }
  }

  const vmLines = formatVmList("Cluster VMs and LXC Containers:", vms, { compact: true });

  return `${summary}\n\n${nodeLines.join("\n")}\n\n${vmLines}`;
}

export async function listAllVmsChain(
  tools: BaseTool[],
  session: ToolSession,
  vmKind?: VmKind
): Promise<string> {
  const labels = getVmKindLabels(vmKind);
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: { operation: "list_all_vms", params: vmKind ? { vmKind } : {} },
    },
    tools,
    session
  );

  if (result.error) {
    throw new Error(result.error);
  }

  const payload = result.data as any;
  const vms = payload?.data ?? [];

  return formatVmList(`All ${labels.listLabel} in the cluster:`, vms, { compact: true });
}

export async function listVmsByNodeChain(
  tools: BaseTool[],
  session: ToolSession,
  nodeName: string,
  vmKind?: VmKind
): Promise<string> {
  // Normalize node name (yang -> YANG, yin -> YIN, etc.)
  const normalizedNode = nodeName.charAt(0).toUpperCase() + nodeName.slice(1).toLowerCase();
  // Handle special cases
  const finalNodeName = normalizedNode === "Proxbig" ? "proxBig" : 
                       normalizedNode === "Yang" ? "YANG" :
                       normalizedNode === "Yin" ? "yin" : normalizedNode;

  const labels = getVmKindLabels(vmKind);
  const allVms = await fetchVmsByNode(tools, session, finalNodeName, vmKind);

  // Format response - NO nodes section, only VMs/containers
  // Use same format as formatVmList for consistency
  if (!allVms.length) {
    const requestedKind = vmKind ?? "all";
    const note =
      requestedKind === "all"
        ? "\n\nNote: The twin may be incomplete. Run Proxmox ingestion to sync all VMs and LXC containers."
        : "";
    return `No ${labels.noneLabel} found in the digital twin for this node.${note}`;
  }

  // Use formatVmList helper for consistent formatting (no nodes)
  return formatVmList(`${labels.listLabel} on node ${finalNodeName}:`, allVms, { compact: true });
}

export async function listRunningVmsOnNodeChain(
  tools: BaseTool[],
  session: ToolSession,
  nodeName: string,
  vmKind?: VmKind
): Promise<string> {
  const requestedKind = vmKind ?? "all";
  if (requestedKind === "all") {
    const allText = await listVmsByNodeChain(tools, session, nodeName, vmKind);
    if (allText.startsWith("No ") && allText.includes("digital twin")) {
      return allText;
    }
  }

  // Re-run the underlying calls to filter deterministically (avoid parsing formatted text).
  const normalizedNode = nodeName.charAt(0).toUpperCase() + nodeName.slice(1).toLowerCase();
  const finalNodeName = normalizedNode === "Proxbig" ? "proxBig" :
                       normalizedNode === "Yang" ? "YANG" :
                       normalizedNode === "Yin" ? "yin" : normalizedNode;

  const labels = getVmKindLabels(vmKind);
  const allVms = await fetchVmsByNode(tools, session, finalNodeName, vmKind);
  const running = allVms.filter((vm) => String(vm.state ?? "").toLowerCase() === "running");

  if (!running.length) {
    return `No running ${labels.noneLabel} found on node ${finalNodeName}.`;
  }

  return formatVmList(`Running ${labels.listLabel} on node ${finalNodeName}:`, running, { compact: true });
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
  return formatVmList("VMs without guest agent data:", vms, { compact: true });
}

export async function listStoppedVmsChain(
  tools: BaseTool[],
  session: ToolSession,
  nodeName: string,
  vmKind?: VmKind
): Promise<string> {
  const labels = getVmKindLabels(vmKind);
  const requestedKind = vmKind ?? "all";
  const requests: Array<Promise<{ kind: "qemu" | "lxc"; result: { error?: string; data?: unknown } }>> = [];

  if (requestedKind !== "lxc") {
    requests.push(
      executeToolCall(
        {
          toolName: "twin_query",
          parameters: { operation: "stopped_vms_on_node", params: { nodeName, vmKind: "qemu" } },
        },
        tools,
        session
      ).then((result) => ({ kind: "qemu", result }))
    );
  }

  if (requestedKind !== "qemu") {
    requests.push(
      executeToolCall(
        {
          toolName: "twin_query",
          parameters: { operation: "stopped_vms_on_node", params: { nodeName, vmKind: "lxc" } },
        },
        tools,
        session
      ).then((result) => ({ kind: "lxc", result }))
    );
  }

  const results = await Promise.all(requests);
  const vms: VmRecord[] = [];

  for (const { result } of results) {
    if (result.error) {
      throw new Error(result.error);
    }
    const payload = result.data as { data?: VmRecord[] } | undefined;
    vms.push(...(payload?.data ?? []));
  }

  return formatVmList(`Stopped ${labels.listLabel} on ${nodeName}:`, sortVmsById(vms), { compact: true });
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

export async function findVmByNameChain(
  tools: BaseTool[],
  session: ToolSession,
  vmName: string,
  vmKind?: VmKind
): Promise<string> {
  const result = await executeToolCall(
    {
      toolName: "twin_query",
      parameters: { operation: "find_vm_by_name", params: { vmName, vmKind } },
    },
    tools,
    session
  );

  if (result.error) {
    throw new Error(result.error);
  }

  const payload = result.data as { data?: VmRecord[] };
  const vms = payload?.data ?? [];

  if (vms.length === 0) {
    return `No VM or container matching "${vmName}" found in the digital twin. Run Proxmox ingestion to sync the twin.`;
  }

  if (vms.length === 1) {
    const vm = vms[0];
    if (!vm) {
      return `No VM or container matching "${vmName}" found in the digital twin. Run Proxmox ingestion to sync the twin.`;
    }
    const label = vm.name || "Unnamed VM";
    const vmType = vm.vmKind === "lxc" ? "LXC container" : "QEMU VM";
    const state = vm.state ?? "unknown";
    const nodeInfo = vm.nodeName ? ` on node ${vm.nodeName}` : "";
    return `${label} is ${state}${nodeInfo}. (${vmType})`;
  }

  const lines: string[] = [`VMs/containers matching "${vmName}":`];
  for (const vm of vms) {
    if (!vm) continue;
    const label = vm.name || "Unnamed VM";
    const vmType = vm.vmKind === "lxc" ? "LXC" : "VM";
    const state = vm.state ?? "unknown";
    const nodeInfo = vm.nodeName ? ` on ${vm.nodeName}` : "";
    lines.push(`- ${label} (${vmType}, ${state}${nodeInfo})`);
  }
  return lines.join("\n");
}

/**
 * Known Proxmox nodes and their endpoints for multi-cluster support
 * This allows VM resolution across all clusters, not just the primary one
 */
const KNOWN_NODES = ["proxBig", "YANG", "YIN"];

/** Minimum length required on both sides of a fuzzy substring VM-name match. See usage below. */
const MIN_FUZZY_MATCH_LENGTH = 3;

/**
 * Resolve VM details by name or ID using cluster_resources
 * This is used before write operations to get the node, vmid, and type
 * 
 * Queries ALL known clusters to find the VM, not just the primary cluster.
 * 
 * @param tools - Available tools
 * @param session - Tool session
 * @param vmNameOrId - VM name (string) or ID (number)
 * @returns Resolved VM details including node, vmid, type, and status
 */
export async function resolveVmDetailsChain(
  tools: BaseTool[],
  session: ToolSession,
  vmNameOrId: string | number
): Promise<ResolvedVmDetails> {
  // Collect all resources from all clusters
  const allResources: any[] = [];
  
  // First, try cluster_resources from primary cluster
  const primaryResult = await executeToolCall(
    {
      toolName: "proxmox_readonly",
      parameters: { action: "cluster_resources" },
    },
    tools,
    session
  );
  
  if (!primaryResult.error) {
    const payload = primaryResult.data as any;
    const resources = payload?.resources ?? [];
    allResources.push(...resources);
  }
  
  // Then query each known node individually to get VMs from all clusters
  // This handles standalone nodes that aren't in the primary cluster
  for (const nodeName of KNOWN_NODES) {
    // Skip if we already have VMs from this node
    const hasNodeVms = allResources.some((r: any) => 
      r.node?.toLowerCase() === nodeName.toLowerCase()
    );
    if (hasNodeVms) continue;
    
    // Query this specific node
    const nodeResult = await executeToolCall(
      {
        toolName: "proxmox_readonly",
        parameters: { action: "list_vms", node: nodeName },
      },
      tools,
      session
    );
    
    if (!nodeResult.error) {
      const payload = nodeResult.data as any;
      const vms = payload?.vms ?? [];
      // Add node name to each VM resource
      for (const vm of vms) {
        allResources.push({
          ...vm,
          node: payload?.node || nodeName,
        });
      }
    }
  }

  if (allResources.length === 0) {
    return {
      vmid: 0,
      node: "",
      name: String(vmNameOrId),
      type: "qemu",
      status: "not_found",
      found: false,
    };
  }

  // Search by name or ID
  const isNumeric = typeof vmNameOrId === "number" || /^\d+$/.test(String(vmNameOrId));
  const searchValue = isNumeric ? Number(vmNameOrId) : String(vmNameOrId).toLowerCase();

  const matches = allResources.filter((r: any) => {
    if (r.type !== "qemu" && r.type !== "lxc") return false;
    
    if (isNumeric) {
      return r.vmid === searchValue;
    } else {
      // Case-insensitive name match
      const name = (r.name || "").toLowerCase();
      const searchStr = String(searchValue);
      if (name === searchStr) return true;
      // Fuzzy substring matching is only meaningful for reasonably specific
      // terms. A degenerately short search string (e.g. a stray character
      // left over from garbled/adversarial input) or short real name would
      // otherwise match almost any VM via .includes() in either direction,
      // silently resolving to an unrelated real destructive target.
      if (searchStr.length < MIN_FUZZY_MATCH_LENGTH || name.length < MIN_FUZZY_MATCH_LENGTH) {
        return false;
      }
      return name.includes(searchStr) || searchStr.includes(name);
    }
  });

  if (matches.length === 0) {
    return {
      vmid: 0,
      node: "",
      name: String(vmNameOrId),
      type: "qemu",
      status: "not_found",
      found: false,
    };
  }

  if (matches.length === 1) {
    const vm = matches[0];
    return {
      vmid: vm.vmid,
      node: vm.node,
      name: vm.name || "",
      type: vm.type as "qemu" | "lxc",
      status: vm.status || "unknown",
      found: true,
    };
  }

  // Multiple matches - return first but flag as ambiguous
  const vm = matches[0];
  return {
    vmid: vm.vmid,
    node: vm.node,
    name: vm.name || "",
    type: vm.type as "qemu" | "lxc",
    status: vm.status || "unknown",
    found: true,
    ambiguous: true,
    matches: matches.map((m: any) => ({
      vmid: m.vmid,
      node: m.node,
      name: m.name || "",
      type: m.type as "qemu" | "lxc",
      status: m.status || "unknown",
    })),
  };
}

