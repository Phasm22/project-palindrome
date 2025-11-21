# IP Resolution Setup - Quick Guide

## What You Need to Do

### Option 1: Use OPNsense DHCP Leases (EASIEST)

**Step 1:** Verify OPNsense MCP tool supports DHCP lease queries

Check if you can query DHCP leases:
```bash
# Test via MCP tool
bun src/cli.ts pce "query opnsense dhcp leases"
```

**Step 2:** If not supported, add DHCP lease query to MCPOpnsenseTool

The MCP tool needs to support:
- `module: "dhcp"`
- `action: "list_leases"` or `action: "get_leases"`

**Step 3:** Use the IP resolver

The system will:
1. Get VM MAC from Proxmox network config
2. Query OPNsense DHCP for that MAC
3. Return the IP

### Option 2: Add SSH Commands (IMMEDIATE FIX)

**Step 1:** Add network commands to approved-commands.yaml

For each VM host (yin, yang, prox_big), add:

```yaml
hosts:
  "172.16.0.11":  # yin
    commands:
      network:
        - "hostname -I"  # Get all IPs
        - "ip addr show"  # Detailed info
        - "qm guest cmd <vmid> network-get-interfaces"  # Via guest agent
```

**Step 2:** The agent can then:
1. Find which node the VM runs on
2. SSH into that node
3. Use `qm guest cmd` to query guest agent
4. Or SSH directly into VM if we know its IP

### Option 3: Enable Proxmox Guest Agent (BEST LONG-TERM)

**Step 1:** Enable guest agent in VM config

For each VM, add to config:
```
agent: 1
```

**Step 2:** Install guest agent in VM

- Linux: `apt install qemu-guest-agent` or `yum install qemu-guest-agent`
- Windows: Install virtio drivers with guest agent

**Step 3:** Query via Proxmox API

The Proxmox API endpoint:
```
GET /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces
```

This returns all network interfaces with IPs.

## Recommended: Quick Fix

**Immediate solution (5 minutes):**

1. **Add SSH command to approved-commands.yaml:**
```yaml
hosts:
  "172.16.0.11":  # yin node
    commands:
      network:
        - "qm guest cmd {vmid} network-get-interfaces"
```

2. **Update the agent to:**
   - Get VM info (node, vmid) from Proxmox
   - SSH into the node
   - Run `qm guest cmd <vmid> network-get-interfaces`
   - Parse IP from response

3. **For OPNsense DHCP (better long-term):**
   - Check if MCP tool supports `dhcp.list_leases`
   - If yes, use MAC from Proxmox → query OPNsense → get IP
   - If no, add that capability to MCP tool

## Testing

Test with "opsbox":
```bash
# 1. Get VM info
bun src/cli.ts pce "what node is opsbox on?"

# 2. Get IP (should work after setup)
bun src/cli.ts pce "what's the IP of opsbox?"
```

## Current Status

- ✅ Proxmox can get VM network config (MAC, bridge, etc.)
- ✅ OPNsense MCP tool exists
- ❓ OPNsense DHCP lease query - needs verification
- ✅ SSH tool exists
- ❓ SSH commands for network queries - need to add
- ❓ Proxmox guest agent queries - need to implement

## Next Steps

1. **Check OPNsense MCP tool** - Can it query DHCP leases?
2. **If yes:** Use MAC → DHCP lookup
3. **If no:** Add SSH command for `qm guest cmd` or implement guest agent query in Proxmox tool

