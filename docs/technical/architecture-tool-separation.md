# Tool Architecture - Correct Separation of Concerns

## Overview

This document defines the correct architecture for tool separation between SSH and Proxmox tools.

## SSH Tool

**Purpose:** OS-level operations on hosts

**Use Cases:**
- ✅ Lightweight commands (`hostname`, `uptime`, `df -h`)
- ✅ File operations on hosts (`ls`, `du`, `tail`, `grep`)
- ✅ Service management (`systemctl restart xyz`, `systemctl status xyz`)
- ✅ Log reads (`journalctl`, `tail -f /var/log/xyz`)
- ✅ Package management (`apt update`, `apt upgrade`)
- ✅ OS-level network diagnostics (`ip addr show`, `ip route show`, `netstat`)
- ✅ System maintenance and monitoring

**NOT for:**
- ❌ VM operations (use Proxmox tool)
- ❌ QM commands (use Proxmox tool)
- ❌ LXC operations (use Proxmox tool)
- ❌ Guest agent operations (use Proxmox tool)
- ❌ VM config/status/migrations (use Proxmox tool)

## Proxmox Tool

**Purpose:** All VM and container operations via Proxmox API

**Use Cases:**
- ✅ All VM operations (start, stop, migrate, clone, etc.)
- ✅ All QM operations (config, status, snapshots, etc.)
- ✅ All LXC operations (config, status, snapshots, etc.)
- ✅ All guest agent operations (network-get-interfaces, etc.)
- ✅ All status/config/migrations
- ✅ VM introspection and metadata

**API Endpoints:**
- `GET /nodes/{node}/qemu/{vmid}/config` - Get VM config
- `GET /nodes/{node}/lxc/{vmid}/config` - Get LXC config
- `GET /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces` - Get VM IPs via guest agent
- `GET /nodes/{node}/qemu/{vmid}/status/current` - Get VM status
- `GET /nodes/{node}/qemu/{vmid}/snapshot` - Get VM snapshots
- And all other Proxmox API endpoints

## Implementation Status

### ✅ Completed

1. **Proxmox Tool Extended:**
   - Added `get_vm_ip` action - Gets VM IP via guest agent with fallback
   - Added `get_lxc_config` action - Gets LXC container config
   - `get_vm_config` already exists - Gets VM config via API
   - `get_vm_network` already exists - Gets VM network config via API

2. **SSH Tool Cleaned:**
   - Removed all `qm` commands from approved-commands.yaml
   - Removed all `pvesh` commands from approved-commands.yaml
   - Added OS-level commands (systemctl, journalctl, ip, etc.)
   - Added maintenance commands (apt update, service restarts)

### 📋 Actions Available

**Proxmox Tool Actions:**
- `list_nodes` - List all nodes
- `node_status` - Get node status
- `node_resources` - Get node resources
- `node_disks` - Get node disk info
- `node_network_interfaces` - Get node network interfaces
- `list_vms` - List VMs on a node
- `get_vm_status` - Get VM status
- `get_vm_config` - Get VM config
- `get_vm_network` - Get VM network config
- `get_vm_snapshots` - Get VM snapshots
- `get_vm_ip` - **NEW** Get VM IP via guest agent
- `get_lxc_config` - **NEW** Get LXC container config
- `cluster_resources` - Get all cluster resources
- `cluster_status` - Get cluster status
- `cluster_ceph_status` - Get Ceph status
- `ha_groups` - Get HA groups
- `ha_resources` - Get HA resources

**SSH Tool Commands:**
- Network: `ip addr show`, `ip route show`, `netstat`, `ss`
- System: `uptime`, `free`, `hostname`, `uname`, `df`, `ps`
- Services: `systemctl status`, `systemctl restart`, `journalctl`
- Maintenance: `apt update`, `apt upgrade`
- Filesystem: `du`, `ls`, `tail`, `grep`

## Example Usage

### Get VM IP (Proxmox Tool)
```typescript
{
  action: "get_vm_ip",
  node: "yang",
  vmid: 211,
  type: "qemu"
}
```

### Get VM Config (Proxmox Tool)
```typescript
{
  action: "get_vm_config",
  node: "yang",
  vmid: 211,
  type: "qemu"
}
```

### Check Service Status (SSH Tool)
```typescript
{
  host: "yang.prox",
  command: "systemctl status {service}",
  service: "pve-cluster"
}
```

### Read Logs (SSH Tool)
```typescript
{
  host: "yang.prox",
  command: "journalctl -u {service} -n 50",
  service: "pve-cluster"
}
```

## Benefits

1. **Clear Separation:** Each tool has a well-defined purpose
2. **Better Security:** SSH only for OS-level, Proxmox API for VM operations
3. **Easier Maintenance:** Changes to VM operations don't affect SSH tool
4. **Better Error Handling:** Proxmox API provides structured errors
5. **Guest Agent Support:** Proper fallback when guest agent unavailable
6. **Type Safety:** Proxmox tool uses structured API responses

## Migration Notes

- All `qm` commands should now use Proxmox tool
- All `pvesh` commands should now use Proxmox tool
- SSH tool is now focused on OS-level operations only
- VM introspection belongs to Proxmox tool, not SSH

