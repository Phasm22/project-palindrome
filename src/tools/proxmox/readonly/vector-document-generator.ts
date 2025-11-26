/**
 * Vector Store Document Generator for Proxmox Data
 * TL-2A.6.A: Generate short-lived structured documents for Vector ingestion
 * 
 * Creates documents for:
 * - VM Inventory
 * - Node Resource Profiles
 * - Cluster Status Summary
 */

import type { ProxmoxReadOnlyParams } from "./proxmox-readonly-tool";
import { ProxmoxReadOnlyTool } from "./proxmox-readonly-tool";
import { ProxmoxClient } from "../client";

export interface ProxmoxDocument {
  content: string;
  metadata: {
    documentType: "vm_inventory" | "node_profile" | "cluster_status";
    source: "proxmox";
    timestamp: string;
    node?: string;
    vmid?: number;
  };
}

/**
 * Generate VM Inventory document
 */
export async function generateVmInventoryDocument(
  client: ProxmoxClient,
  node: string
): Promise<ProxmoxDocument> {
  const tool = new ProxmoxReadOnlyTool();
  
  // Fetch both QEMU and LXC VMs
  const [qemuResult, lxcResult] = await Promise.all([
    tool.execute(
      { action: "list_vms", node, type: "qemu" },
      { toolName: "proxmox_readonly", startedAt: Date.now() }
    ).catch(() => ({ error: null, data: { vms: [] } })),
    tool.execute(
      { action: "list_vms", node, type: "lxc" },
      { toolName: "proxmox_readonly", startedAt: Date.now() }
    ).catch(() => ({ error: null, data: { vms: [] } })),
  ]);

  // Combine QEMU and LXC VMs
  const qemuVms = qemuResult.data?.vms || [];
  const lxcVms = lxcResult.data?.vms || [];
  const vms = [...qemuVms, ...lxcVms];

  const lines: string[] = [];

  lines.push(`# VM Inventory for Node: ${node}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Total VMs: ${vms.length} (${qemuVms.length} QEMU, ${lxcVms.length} LXC)`);
  lines.push("");

  for (const vm of vms) {
    lines.push(`## VM ${vm.vmid}: ${vm.name || "Unnamed"}`);
    lines.push(`- Status: ${vm.status_normalized || vm.status || "unknown"}`);
    lines.push(`- Type: ${vm.type || "qemu"}`);
    
    if (vm.mem_normalized && vm.maxmem_normalized) {
      lines.push(
        `- Memory: ${vm.mem_normalized.value} ${vm.mem_normalized.unit} / ${vm.maxmem_normalized.value} ${vm.maxmem_normalized.unit}`
      );
    }
    
    if (vm.cpu !== undefined) {
      lines.push(`- CPU Usage: ${(vm.cpu * 100).toFixed(1)}%`);
    }
    
    if (vm.uptime_iso8601) {
      lines.push(`- Uptime: ${vm.uptime_iso8601}`);
    }
    
    lines.push("");
  }

  return {
    content: lines.join("\n"),
    metadata: {
      documentType: "vm_inventory",
      source: "proxmox",
      timestamp: new Date().toISOString(),
      node,
    },
  };
}

/**
 * Generate Node Resource Profile document
 */
export async function generateNodeProfileDocument(
  client: ProxmoxClient,
  node: string
): Promise<ProxmoxDocument> {
  const tool = new ProxmoxReadOnlyTool();
  const statusResult = await tool.execute(
    { action: "node_status", node },
    { toolName: "proxmox_readonly", startedAt: Date.now() }
  );

  if (statusResult.error) {
    throw new Error(
      `Failed to generate node profile: ${statusResult.error}`
    );
  }

  const status = statusResult.data || {};
  // node_status provides the same information as node_resources (which was removed)
  const resources = status;

  const lines: string[] = [];

  lines.push(`# Node Resource Profile: ${node}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");

  lines.push("## Status");
  lines.push(`- Status: ${status.status_normalized || status.status || "unknown"}`);
  lines.push(`- Uptime: ${status.uptime_iso8601 || "N/A"}`);
  lines.push("");

  if (resources.memory) {
    const used = resources.memory.used_normalized
      ? `${resources.memory.used_normalized.value} ${resources.memory.used_normalized.unit}`
      : "N/A";
    const total = resources.memory.total_normalized
      ? `${resources.memory.total_normalized.value} ${resources.memory.total_normalized.unit}`
      : "N/A";
    lines.push("## Memory");
    lines.push(`- Used: ${used}`);
    lines.push(`- Total: ${total}`);
    lines.push("");
  }

  if (resources.cpu) {
    lines.push("## CPU");
    lines.push(`- Usage: ${(resources.cpu.usage * 100).toFixed(1)}%`);
    lines.push(`- Cores: ${resources.cpu.cores || "N/A"}`);
    lines.push("");
  }

  if (status.kversion) {
    lines.push("## System");
    lines.push(`- Kernel: ${status.kversion}`);
    lines.push(`- PVE Version: ${status.pveversion || "N/A"}`);
    lines.push("");
  }

  return {
    content: lines.join("\n"),
    metadata: {
      documentType: "node_profile",
      source: "proxmox",
      timestamp: new Date().toISOString(),
      node,
    },
  };
}

/**
 * Generate Cluster Status Summary document
 */
export async function generateClusterStatusDocument(
  client: ProxmoxClient
): Promise<ProxmoxDocument> {
  const tool = new ProxmoxReadOnlyTool();
  
  const nodesResult = await tool.execute(
    { action: "list_nodes" },
    { toolName: "proxmox_readonly", startedAt: Date.now() }
  );

  const clusterStatusResult = await tool.execute(
    { action: "cluster_status" },
    { toolName: "proxmox_readonly", startedAt: Date.now() }
  );

  const resourcesResult = await tool.execute(
    { action: "cluster_resources" },
    { toolName: "proxmox_readonly", startedAt: Date.now() }
  );

  if (nodesResult.error || clusterStatusResult.error) {
    throw new Error(
      `Failed to generate cluster status: ${nodesResult.error || clusterStatusResult.error}`
    );
  }

  const nodes = nodesResult.data?.nodes || [];
  const clusterStatus = clusterStatusResult.data || {};
  const resources = resourcesResult.data?.resources || [];

  const lines: string[] = [];

  lines.push(`# Cluster Status Summary`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");

  if (clusterStatus.quorum) {
    lines.push("## Quorum");
    lines.push(`- Status: ${clusterStatus.quorum.quorate ? "OK" : "NOT OK"}`);
    lines.push(
      `- Votes: ${clusterStatus.quorum.votes || 0} / ${clusterStatus.quorum.expected_votes || 0}`
    );
    lines.push("");
  }

  lines.push("## Nodes");
  lines.push(`Total Nodes: ${nodes.length}`);
  for (const node of nodes) {
    const status = node.status_normalized || node.status || "unknown";
    lines.push(`- ${node.node}: ${status}`);
  }
  lines.push("");

  lines.push("## Resources");
  lines.push(`Total Resources: ${resources.length}`);
  const runningVms = resources.filter((r: any) => r.status === "running");
  const stoppedVms = resources.filter((r: any) => r.status === "stopped");
  lines.push(`- Running VMs: ${runningVms.length}`);
  lines.push(`- Stopped VMs: ${stoppedVms.length}`);
  lines.push("");

  return {
    content: lines.join("\n"),
    metadata: {
      documentType: "cluster_status",
      source: "proxmox",
      timestamp: new Date().toISOString(),
    },
  };
}

/**
 * Generate all Proxmox documents for a cluster
 */
export async function generateAllProxmoxDocuments(
  client: ProxmoxClient
): Promise<ProxmoxDocument[]> {
  const documents: ProxmoxDocument[] = [];

  // Get list of nodes
  const tool = new ProxmoxReadOnlyTool();
  const nodesResult = await tool.execute(
    { action: "list_nodes" },
    { toolName: "proxmox_readonly", startedAt: Date.now() }
  );

  if (nodesResult.error || !nodesResult.data) {
    throw new Error(`Failed to list nodes: ${nodesResult.error}`);
  }

  const nodes = nodesResult.data.nodes || [];

  // Generate cluster status
  try {
    const clusterDoc = await generateClusterStatusDocument(client);
    documents.push(clusterDoc);
  } catch (error: any) {
    console.error(`Failed to generate cluster status: ${error.message}`);
  }

  // Generate node profiles and VM inventories
  for (const node of nodes) {
    const nodeName = node.node;
    if (!nodeName) continue;

    try {
      const nodeDoc = await generateNodeProfileDocument(client, nodeName);
      documents.push(nodeDoc);
    } catch (error: any) {
      console.error(`Failed to generate node profile for ${nodeName}: ${error.message}`);
    }

    try {
      const vmDoc = await generateVmInventoryDocument(client, nodeName);
      documents.push(vmDoc);
    } catch (error: any) {
      console.error(`Failed to generate VM inventory for ${nodeName}: ${error.message}`);
    }
  }

  return documents;
}

