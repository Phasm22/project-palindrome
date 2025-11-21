# SSH IP Resolution - Current Status

## Issue Summary

SSH connection to Proxmox nodes works correctly:
- ✅ Connection established
- ✅ Authentication successful (using `opsadmin` user and default SSH keys)
- ✅ Commands execute
- ✅ Simple commands (like `hostname`) return correct output

**Problem:** `qm` commands are returning guest agent errors instead of actual output:
```
ipcc_send_rec[1] failed: Unknown error -1
ipcc_send_rec[2] failed: Unknown error -1
ipcc_send_rec[3] failed: Unknown error -1
Unable to load access control list: Unknown error -1
```

This happens even for commands that shouldn't need the guest agent (like `qm config`, `qm status`).

## What Works

1. **SSH Connection:**
   - Host resolution: `yang.prox` → `172.16.0.12` ✅
   - Username from config: `opsadmin` ✅
   - Default SSH keys: `~/.ssh/id_ed25519` ✅
   - Simple commands: `hostname`, `uptime` ✅

2. **Command Execution:**
   - Commands are approved and execute ✅
   - Placeholder substitution works: `{vmid}` → `211` ✅

## What Doesn't Work

1. **Guest Agent Commands:**
   - `/usr/sbin/qm guest cmd {vmid} network-get-interfaces` - Returns errors
   - `pvesh get /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces` - Returns errors

2. **Even Non-Guest-Agent Commands:**
   - `/usr/sbin/qm config {vmid}` - Returns guest agent errors (unexpected)
   - `/usr/sbin/qm status {vmid}` - Returns guest agent errors (unexpected)

## Possible Causes

1. **Guest Agent Not Running:** The QEMU guest agent might not be running in the VM
2. **Permission Issues:** `opsadmin` user might not have permissions to access guest agent
3. **Proxmox Configuration:** Guest agent might not be enabled in VM config
4. **Environment Issues:** Something in the SSH environment is triggering guest agent calls

## Alternative Solutions

Since guest agent isn't working, here are alternatives:

### Option 1: Use Proxmox API Directly
Instead of SSH, use the Proxmox API via the existing `proxmox_readonly` tool:
- Add endpoint: `GET /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces`
- This might work even if SSH doesn't

### Option 2: Query Topology Graph
If VMs are defined in `topology.yaml`, get IPs from there:
- Query graph for VM by name
- Extract IP from attributes

### Option 3: Use OPNsense DHCP Leases
1. Get VM MAC from Proxmox config (if we can get config working)
2. Query OPNsense DHCP leases for that MAC
3. Return the IP

### Option 4: Fix Guest Agent
1. Enable guest agent in VM config: `agent: 1`
2. Install guest agent in VM (qemu-guest-agent package)
3. Ensure guest agent service is running in VM

## Next Steps

1. **Test Proxmox API directly** - Try the agent endpoint via API instead of SSH
2. **Check VM config** - See if guest agent is enabled
3. **Try different user** - Test with root or different permissions
4. **Use topology.yaml** - For VMs defined there, use IPs from the file

## Current Configuration

**SSH Tool:**
- Uses `exec` mode for Proxmox nodes (not shell mode)
- Reads username from `approved-commands.yaml`
- Uses default SSH keys from `~/.ssh/`
- Supports placeholder substitution: `{vmid}`, `{node}`

**Approved Commands:**
- `/usr/sbin/qm guest cmd {vmid} network-get-interfaces`
- `/usr/sbin/qm config {vmid}`
- `/usr/sbin/qm status {vmid}`
- `pvesh get /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces --output-format json`

**Hosts Configured:**
- `yang.prox` (172.16.0.12) - username: `opsadmin`
- `yin.prox` (172.16.0.11) - username: `opsadmin`
- `prox_big.prox` (172.16.0.10) - username: `opsadmin`




# SSH IP Resolution - Debugging Guide

## Current Issue

SSH connection works, but `qm` commands return guest agent errors even when tested manually:

```bash
$ ssh opsadmin@yang.prox "/usr/sbin/qm config 211"
ipcc_send_rec[1] failed: Unknown error -1
ipcc_send_rec[2] failed: Unknown error -1
ipcc_send_rec[3] failed: Unknown error -1
Unable to load access control list: Unknown error -1
```

## What Works

✅ SSH connection to `yang.prox`, `yin.prox`, `prox_big.prox`  
✅ Username `opsadmin` from config  
✅ Default SSH keys (`~/.ssh/id_ed25519`)  
✅ Simple commands: `hostname`, `uptime`, `echo`  
✅ Placeholder substitution: `{vmid}`, `{node}`  

## What Doesn't Work

❌ `qm config {vmid}` - Returns guest agent errors  
❌ `qm status {vmid}` - Returns guest agent errors  
❌ `qm guest cmd {vmid} network-get-interfaces` - Returns guest agent errors  
❌ `pvesh get /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces` - Returns guest agent errors  

## Questions for You

Since you mentioned you have zero issues doing it manually:

1. **What exact command do you use?**
   - Is it `qm config 211`?
   - Or something else?

2. **How do you run it?**
   - Directly on the node (not via SSH)?
   - Via SSH but with different user/permissions?
   - Using a different method?

3. **What output do you get?**
   - Do you see the guest agent errors?
   - Or does it work without errors?

4. **Guest agent status:**
   - Is the guest agent enabled in the VM config?
   - Is the guest agent service running in the VM?

## Possible Solutions

### Option 1: Use Proxmox API Directly
Add a method to the Proxmox tool to get VM IPs via API instead of SSH:

```typescript
// In proxmox-readonly-tool.ts
case "get_vm_ip":
  const agentResult = await client.execute(
    `nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`,
    "GET"
  );
  // Parse and return IPs
```

### Option 2: Fix Guest Agent
If guest agent isn't working:
1. Enable in VM config: `agent: 1`
2. Install in VM: `apt install qemu-guest-agent`
3. Start service in VM: `systemctl start qemu-guest-agent`

### Option 3: Use Topology Graph
For VMs defined in `topology.yaml`, query the graph for IPs.

### Option 4: Query OPNsense DHCP
1. Get VM MAC from Proxmox (if we can get config working)
2. Query OPNsense DHCP leases
3. Match MAC to IP

## Current SSH Tool Status

The SSH tool is working correctly:
- ✅ Connection and authentication
- ✅ Command execution
- ✅ Output collection (for commands that produce output)
- ✅ Placeholder substitution
- ✅ Host resolution (IP and DNS names with `.prox` domain)

The issue is specifically with `qm` commands returning guest agent errors instead of actual output.




# IP Resolution Recommendations

## Current Status

SSH connection works, but `qm` commands return guest agent errors. Since you mentioned you have zero issues doing it manually, here are recommendations:

## Recommended Approach: Use Proxmox API Directly

Instead of SSH, use the Proxmox API via the existing `proxmox_readonly` tool:

### Add to Proxmox Tool

Add a new action to get VM IP via guest agent API:

```typescript
// In proxmox-readonly-tool.ts
case "get_vm_ip":
  return this.getVmIP(client, params.node, params.vmid, vmType);

// Implementation
private async getVmIP(client: ProxmoxClient, node: string, vmid: number, type: string) {
  try {
    // Try guest agent first
    const agentResult = await client.execute(
      `nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`,
      "GET"
    );
    
    if (agentResult && agentResult.result) {
      // Parse and return IPs
      const interfaces = agentResult.result;
      const ips = [];
      for (const iface of interfaces) {
        if (iface['ip-addresses']) {
          for (const ip of iface['ip-addresses']) {
            if (ip['ip-address-type'] === 'ipv4' && !ip['ip-address'].startsWith('127.')) {
              ips.push(ip['ip-address']);
            }
          }
        }
      }
      return { ips, source: 'guest_agent' };
    }
  } catch (error) {
    // Guest agent not available, try other methods
  }
  
  // Fallback: Get MAC from config, then query OPNsense DHCP
  // Or return null
  return { ips: [], source: 'none' };
}
```

## Alternative: Fix SSH Output Collection

If you want to continue using SSH, the issue might be:

1. **Output timing** - Commands might produce output after we close the connection
2. **Environment differences** - Your manual SSH might use a different shell/environment
3. **Permission differences** - Your manual session might have different permissions

### Debug Steps

1. **Test manually with exact same command:**
   ```bash
   ssh opsadmin@yang.prox "/usr/sbin/qm config 211"
   ```

2. **Check if output appears after errors:**
   - The guest agent errors might be warnings
   - Actual output might come after

3. **Try with different shell:**
   ```bash
   ssh opsadmin@yang.prox "bash -c '/usr/sbin/qm config 211'"
   ```

4. **Check VM guest agent status:**
   ```bash
   ssh opsadmin@yang.prox "/usr/sbin/qm config 211 | grep agent"
   ```

## Quick Fix: Use Topology Graph

For VMs defined in `topology.yaml`, query the graph:

```typescript
// Query graph for VM
const vmNode = await graphQuery.findEntitiesByIdOrName("opsbox");
if (vmNode.nodes.length > 0 && vmNode.nodes[0].attributes.ip) {
  return vmNode.nodes[0].attributes.ip;
}
```

## Next Steps

1. **Test Proxmox API directly** - Add `get_vm_ip` action to proxmox_readonly tool
2. **Check your manual method** - What exact command do you use that works?
3. **Enable guest agent** - If not enabled, that would explain the errors
4. **Use topology.yaml** - For defined VMs, use IPs from there

