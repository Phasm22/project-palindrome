/**
 * CLI formatter for Proxmox read-only tool output
 * Provides human-readable, pretty-printed output from normalized structures
 */

export interface FormatOptions {
  json?: boolean;
  compact?: boolean;
}

/**
 * Format Proxmox tool output for CLI display
 */
export function formatProxmoxOutput(
  data: any,
  action: string,
  options: FormatOptions = {}
): string {
  if (options.json) {
    // JSON output mode
    return JSON.stringify(data, null, 2);
  }

  // Remove provenance metadata for display (it's internal)
  const displayData = { ...data };
  if (displayData._provenance) {
    delete displayData._provenance;
  }

  // Format based on action type
  if (action.startsWith("list_")) {
    return formatListOutput(displayData, action);
  } else if (action.startsWith("get_") || action.startsWith("node_") || action.startsWith("cluster_") || action.startsWith("ha_")) {
    return formatDetailOutput(displayData, action);
  }

  // Default: formatted JSON
  return JSON.stringify(displayData, null, 2);
}

/**
 * Format list output (nodes, VMs, etc.)
 */
function formatListOutput(data: any, action: string): string {
  const lines: string[] = [];

  if (action === "list_nodes" && data.nodes) {
    lines.push("Nodes:");
    lines.push("─".repeat(80));
    for (const node of data.nodes) {
      const status = node.status_normalized || node.status || "unknown";
      const cpu = node.cpu !== undefined ? `${(node.cpu * 100).toFixed(1)}%` : "N/A";
      const mem = node.mem_normalized
        ? `${node.mem_normalized.value} ${node.mem_normalized.unit}`
        : "N/A";
      const maxMem = node.maxmem_normalized
        ? `${node.maxmem_normalized.value} ${node.maxmem_normalized.unit}`
        : "N/A";
      lines.push(`  ${node.node || "N/A"}: ${status} | CPU: ${cpu} | Memory: ${mem}/${maxMem}`);
    }
    lines.push(`\nTotal: ${data.count || 0} nodes`);
  } else if (action === "list_vms" && data.vms) {
    lines.push(`${data.type?.toUpperCase() || "VM"}s on ${data.node}:`);
    lines.push("─".repeat(80));
    for (const vm of data.vms) {
      const status = vm.status_normalized || vm.status || "unknown";
      const name = vm.name || `VM ${vm.vmid}`;
      const mem = vm.mem_normalized
        ? `${vm.mem_normalized.value} ${vm.mem_normalized.unit}`
        : "N/A";
      const maxMem = vm.maxmem_normalized
        ? `${vm.maxmem_normalized.value} ${vm.maxmem_normalized.unit}`
        : "N/A";
      lines.push(`  [${vm.vmid}] ${name}: ${status} | Memory: ${mem}/${maxMem}`);
    }
    lines.push(`\nTotal: ${data.count || 0} VMs`);
  } else if (data.disks && Array.isArray(data.disks)) {
    lines.push(`Disks on ${data.node}:`);
    lines.push("─".repeat(80));
    for (const disk of data.disks) {
      const size = disk.size_normalized
        ? `${disk.size_normalized.value} ${disk.size_normalized.unit}`
        : disk.size || "N/A";
      lines.push(`  ${disk.devpath || "N/A"}: ${disk.type || "N/A"} | ${size} | ${disk.model || "N/A"}`);
    }
    lines.push(`\nTotal: ${data.count || 0} disks`);
  } else if (data.interfaces && Array.isArray(data.interfaces)) {
    lines.push(`Network Interfaces on ${data.node}:`);
    lines.push("─".repeat(80));
    for (const iface of data.interfaces) {
      const address = iface.address || "N/A";
      const status = iface.active ? "UP" : "DOWN";
      lines.push(`  ${iface.iface || "N/A"}: ${iface.type || "N/A"} | ${address} | ${status}`);
    }
    lines.push(`\nTotal: ${data.count || 0} interfaces`);
  } else if (data.resources && Array.isArray(data.resources)) {
    lines.push("Cluster Resources:");
    lines.push("─".repeat(80));
    for (const resource of data.resources) {
      const status = resource.status_normalized || resource.status || "unknown";
      lines.push(`  ${resource.id || "N/A"}: ${status} | Node: ${resource.node || "N/A"}`);
    }
    lines.push(`\nTotal: ${data.count || 0} resources`);
  } else if (data.groups && Array.isArray(data.groups)) {
    lines.push("HA Groups:");
    lines.push("─".repeat(80));
    for (const group of data.groups) {
      lines.push(`  ${group.group || "N/A"}: Nodes: ${group.nodes || "N/A"}`);
    }
    lines.push(`\nTotal: ${data.count || 0} groups`);
  } else if (data.snapshots && Array.isArray(data.snapshots)) {
    lines.push(`Snapshots for VM ${data.vmid} on ${data.node}:`);
    lines.push("─".repeat(80));
    for (const snapshot of data.snapshots) {
      const time = snapshot.snaptime_iso8601 || snapshot.snaptime || "N/A";
      lines.push(`  ${snapshot.name || "N/A"}: ${time} | ${snapshot.description || "No description"}`);
    }
    lines.push(`\nTotal: ${data.count || 0} snapshots`);
  } else {
    // Fallback to JSON
    return JSON.stringify(data, null, 2);
  }

  return lines.join("\n");
}

/**
 * Format detail output (status, config, etc.)
 */
function formatDetailOutput(data: any, action: string): string {
  const lines: string[] = [];

  if (action === "node_status" || action === "node_resources") {
    lines.push(`Node: ${data.node || "N/A"}`);
    lines.push("─".repeat(80));
    if (data.status_normalized) {
      lines.push(`Status: ${data.status_normalized}`);
    }
    if (data.cpu !== undefined) {
      lines.push(`CPU Usage: ${(data.cpu * 100).toFixed(1)}%`);
    }
    if (data.memory) {
      const used = data.memory.used_normalized
        ? `${data.memory.used_normalized.value} ${data.memory.used_normalized.unit}`
        : "N/A";
      const total = data.memory.total_normalized
        ? `${data.memory.total_normalized.value} ${data.memory.total_normalized.unit}`
        : "N/A";
      lines.push(`Memory: ${used} / ${total}`);
    }
    if (data.uptime_iso8601) {
      lines.push(`Uptime: ${data.uptime_iso8601}`);
    }
  } else if (action.startsWith("get_vm_")) {
    lines.push(`VM ${data.vmid || "N/A"} on ${data.node || "N/A"}`);
    lines.push("─".repeat(80));
    if (data.status_normalized) {
      lines.push(`Status: ${data.status_normalized}`);
    }
    if (data.mem_normalized && data.maxmem_normalized) {
      lines.push(
        `Memory: ${data.mem_normalized.value} ${data.mem_normalized.unit} / ${data.maxmem_normalized.value} ${data.maxmem_normalized.unit}`
      );
    }
    if (data.cpu !== undefined) {
      lines.push(`CPU Usage: ${(data.cpu * 100).toFixed(1)}%`);
    }
    if (action === "get_vm_config") {
      lines.push("\nConfiguration:");
      for (const [key, value] of Object.entries(data)) {
        if (!key.startsWith("_") && key !== "node" && key !== "vmid" && key !== "type" && key !== "status" && key !== "mem" && key !== "maxmem" && key !== "cpu") {
          lines.push(`  ${key}: ${value}`);
        }
      }
    } else if (action === "get_vm_network" && data.network) {
      lines.push("\nNetwork Configuration:");
      for (const [key, value] of Object.entries(data.network)) {
        lines.push(`  ${key}: ${value}`);
      }
    }
  } else if (action === "cluster_status") {
    lines.push("Cluster Status:");
    lines.push("─".repeat(80));
    if (data.quorum) {
      lines.push(`Quorum: ${data.quorum.quorate ? "OK" : "NOT OK"}`);
      lines.push(`Votes: ${data.quorum.votes || 0} / ${data.quorum.expected_votes || 0}`);
    }
    if (data.nodes && Array.isArray(data.nodes)) {
      lines.push("\nNodes:");
      for (const node of data.nodes) {
        const status = node.online ? "ONLINE" : "OFFLINE";
        const local = node.local ? " (local)" : "";
        lines.push(`  ${node.name || "N/A"}: ${status}${local}`);
      }
    }
  } else if (action === "cluster_ceph_status") {
    if (data.configured === false) {
      lines.push("Ceph: Not configured on this cluster");
    } else {
      lines.push("Ceph Status:");
      lines.push("─".repeat(80));
      if (data.health) {
        lines.push(`Health: ${JSON.stringify(data.health)}`);
      }
    }
  } else {
    // Fallback to JSON
    return JSON.stringify(data, null, 2);
  }

  return lines.join("\n");
}

