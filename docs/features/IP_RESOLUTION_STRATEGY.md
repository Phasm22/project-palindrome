# IP Address Resolution Strategy

## Problem
Proxmox API doesn't directly expose VM IP addresses. The `get_vm_network` action shows network configuration (bridge, model, etc.) but not the actual assigned IP.

## Solution Options (in priority order)

### Option 1: Query OPNsense DHCP Leases (RECOMMENDED)
**Best for:** Lab network VMs (172.16.0.0/22)

Since OPNsense is the lab firewall and likely runs DHCP, we can query DHCP leases:

```typescript
// Use MCPOpnsenseTool
{
  module: "dhcp",
  action: "list", // or "get_leases" / "search"
  // This should return DHCP lease table with MAC -> IP mappings
}
```

**Steps:**
1. Get VM MAC address from Proxmox `get_vm_network`
2. Query OPNsense DHCP leases for that MAC
3. Return the IP

**Pros:**
- Works for all DHCP-assigned IPs
- Centralized source of truth
- No need to SSH into VMs

**Cons:**
- Only works for DHCP-assigned IPs
- Requires OPNsense access

### Option 2: Use Proxmox Guest Agent
**Best for:** VMs with QEMU guest agent enabled

Proxmox can get IPs via guest agent if enabled:

```bash
# Check if guest agent is enabled in VM config
# If yes, Proxmox API might expose IPs via agent
```

**Steps:**
1. Check VM config for `agent: 1` or `agent: enabled`
2. If enabled, query guest agent for network info
3. Extract IP from agent response

**Pros:**
- Works for static and DHCP IPs
- Direct from VM

**Cons:**
- Requires guest agent to be enabled
- Not all VMs have it

### Option 3: SSH into VM
**Best for:** VMs we can SSH into

Use SSHTool to query the VM directly:

```typescript
// Add to approved-commands.yaml for each host
commands:
  network:
    - "hostname -I"  # Get all IPs
    - "ip addr show"  # Detailed network info
    - "ifconfig"  # Alternative
```

**Steps:**
1. Find which node the VM runs on (from Proxmox)
2. Get VM IP from topology.yaml or Proxmox network config
3. SSH into VM and run `hostname -I` or `ip addr`
4. Parse IP from output

**Pros:**
- Works for any VM we can SSH into
- Most accurate

**Cons:**
- Requires SSH access
- Requires knowing VM IP first (chicken/egg)
- Slower

### Option 4: Query Topology Graph
**Best for:** VMs defined in topology.yaml

We just ingested topology.yaml which has IPs for hosts. We can:

1. Query graph for VM/container by name
2. Check if it has IP in attributes
3. If not, check host it runs on
4. Use host IP or network info

**Pros:**
- Fast (graph query)
- Works for defined infrastructure

**Cons:**
- Only works for VMs in topology.yaml
- IPs might be outdated

## Recommended Implementation

### Phase 1: Multi-source IP Resolution Function

Create a function that tries multiple sources in order:

```typescript
async function resolveVMIP(vmName: string, node?: string, vmid?: number): Promise<string | null> {
  // 1. Try topology graph first (fastest)
  const graphIP = await queryGraphForIP(vmName);
  if (graphIP) return graphIP;

  // 2. Try OPNsense DHCP leases (if lab network)
  const mac = await getVMMACAddress(node, vmid);
  if (mac) {
    const dhcpIP = await queryOPNsenseDHCP(mac);
    if (dhcpIP) return dhcpIP;
  }

  // 3. Try Proxmox guest agent (if enabled)
  const agentIP = await getVMIPFromGuestAgent(node, vmid);
  if (agentIP) return agentIP;

  // 4. Try SSH (if we have access)
  const sshIP = await getVMIPViaSSH(vmName, node);
  if (sshIP) return sshIP;

  return null;
}
```

### Phase 2: Enhance OPNsense Tool

Add DHCP lease querying to MCPOpnsenseTool:

```typescript
// In mcp-opnsense schema, add:
dhcp_actions: [
  "list_leases",      // List all DHCP leases
  "get_lease_by_mac", // Get lease by MAC address
  "get_lease_by_ip",  // Get lease by IP
  "search_leases",    // Search leases
]
```

### Phase 3: Add IP to Graph

When ingesting Proxmox data, try to get IPs and store in graph:

```typescript
// In Proxmox ingestion
const vmIP = await resolveVMIP(vm.name, vm.node, vm.vmid);
if (vmIP) {
  node.attributes.ip = vmIP;
}
```

## Quick Fix (Immediate)

For now, the easiest solution is:

1. **Add OPNsense DHCP query** - Check if MCP tool supports listing DHCP leases
2. **Add SSH commands** - Add `hostname -I` to approved commands for VMs
3. **Use topology.yaml** - For VMs defined there, use the IP from the file

## Testing

Test with "opsbox" VM:
1. Get VM info from Proxmox (node, vmid, MAC)
2. Query OPNsense DHCP for MAC
3. If found, return IP
4. If not, try SSH if we know the host

