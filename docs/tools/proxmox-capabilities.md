# Proxmox tool capabilities and API routes

This document summarizes what the `proxmox_readonly` and `proxmox_write` tools can do, how they map to the Proxmox VE API, and when to use each action. Use it as a quick reference when answering questions about supported functionality.

## Read-only tool (`proxmox_readonly`)

The read-only tool exposes clustered inventory, node health, VM/container state, network information, and HA/Ceph metadata without performing any writes. All responses are normalized (human-friendly units, sanitized secrets) before being returned.

### Actions and API routes

| Category | Action | Proxmox API route | What it returns | Notes |
| --- | --- | --- | --- | --- |
| Nodes | `list_nodes` | `GET /nodes` | Online nodes with CPU, memory, uptime, and status flags. | Base discovery call for node names. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L86-L122】 |
| Nodes | `node_status` | `GET /nodes/{node}/status` | Status/uptime for a specific node. | Requires `node`. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L144-L173】 |
| Nodes | `node_resources` | `GET /nodes/{node}/status` | CPU cores/usage, memory totals, uptime, kernel/PVE versions. | Requires `node`; reuses status endpoint. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L175-L209】 |
| Nodes | `node_disks` | `GET /nodes/{node}/disks/list` | Device paths, size, model, vendor, usage. | Requires `node`. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L213-L241】 |
| Nodes | `node_network_interfaces` | `GET /nodes/{node}/network` | Interface type, addresses, gateways, autostart/active flags. | Requires `node`. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L243-L276】 |
| Nodes | `list_vms` | `GET /nodes/{node}/{qemu|lxc}` | VM/container inventory for a node (CPU, memory, disk, uptime). | Requires `node`; `type` defaults to `qemu`. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L278-L311】 |
| VMs | `get_vm_status` | `GET /nodes/{node}/{type}/{vmid}/status/current` | Current runtime state, uptime, CPU, memory usage. | Auto-detects type when omitted. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L327-L360】 |
| VMs | `get_vm_config` | `GET /nodes/{node}/{type}/{vmid}/config` | Full VM/LXC configuration. | Auto-detects `type`; works for both qemu and lxc. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L362-L392】 |
| VMs | `get_vm_network` | `GET /nodes/{node}/{type}/{vmid}/config` | Network adapters extracted from VM config (bridge/model/MAC strings). | Uses config to build a network map. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L392-L427】 |
| VMs | `get_vm_snapshots` | `GET /nodes/{node}/{type}/{vmid}/snapshot` | Snapshot list with names, parents, timestamps. | Works for qemu and lxc. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L429-L454】 |
| VMs | `get_vm_ip` | `GET /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces` | Guest-agent IPs per interface; falls back to parsing MACs from config. | Only for qemu; returns fallback guidance if agent unavailable. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L456-L556】【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L558-L623】 |
| VMs | `get_lxc_config` | `GET /nodes/{node}/lxc/{vmid}/config` | LXC container configuration. | Explicit LXC helper. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L625-L649】 |
| Cluster | `cluster_resources` | `GET /cluster/resources` | Cluster-wide VM/container inventory with node placement. | Use to resolve VM names to vmid/node/type. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L655-L689】 |
| Cluster | `cluster_status` | `GET /cluster/status` | Quorum state and node online status. | Works even without Ceph/HA. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L691-L724】 |
| Cluster | `cluster_ceph_status` | `GET /cluster/ceph/status` | Ceph health/time data or a configured=false message. | Gracefully handles missing Ceph. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L726-L753】 |
| Cluster | `ha_groups` | `GET /cluster/ha/groups` | HA groups and membership. | Returns configured=false if HA disabled. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L755-L787】 |
| Cluster | `ha_resources` | `GET /cluster/ha/resources` | HA-managed resources and states. | Returns configured=false if HA disabled. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L789-L817】 |

### Usage guidance

- Always start with `cluster_resources` when the user provides a VM/container name; it tells you the `vmid`, node, and whether it is `qemu` or `lxc`. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L39-L63】
- Node-scoped actions require the `node` parameter; VM-scoped actions require both `node` and `vmid`.
- IP lookups depend on the Proxmox guest agent. When unavailable, the tool returns MAC addresses from config so you can correlate with DHCP/firewall logs. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L456-L556】【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L558-L623】
- Ceph and HA endpoints gracefully return `configured:false` when the feature is not enabled, so the agent can still answer without errors. 【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L726-L753】【F:src/tools/proxmox/readonly/proxmox-readonly-tool.ts†L755-L817】

## Safe write tool (`proxmox_write`)

The write tool performs controlled lifecycle operations with built-in dry-runs, provenance snapshots, and confirmation requirements. All actions expect the physical node name and `vmid`; the optional `type` defaults to `qemu` but must be set to `lxc` for containers.

### Actions and API routes

| Action | Proxmox API route | Behavior | Dry-run preview | Notes |
| --- | --- | --- | --- | --- |
| `start_vm` | `POST /nodes/{node}/{type}/{vmid}/status/start` | Starts a VM/LXC. | Shows diff from current status to `running`. 【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L252-L301】 | Captures pre-write state hash. |
| `stop_vm` | `POST /nodes/{node}/{type}/{vmid}/status/stop` | Hard stops a VM/LXC (optional timeout). | Preview shows transition to `stopped` with timeout. 【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L303-L355】 | Uses timeout param when provided. |
| `shutdown_vm` | `POST /nodes/{node}/{type}/{vmid}/status/shutdown` | ACPI shutdown with optional timeout. | Preview shows graceful shutdown target state. 【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L357-L409】 | Requires guest support for ACPI. |
| `reboot_vm` | `POST /nodes/{node}/{type}/{vmid}/status/reboot` | Soft reboot. | Preview sets status to `rebooting`. 【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L411-L449】 | Works for qemu/lxc. |
| `reset_vm` | `POST /nodes/{node}/{type}/{vmid}/status/reset` | Hard reset (qemu only). | Preview sets status to `resetting`. 【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L451-L491】 | Throws error for LXC containers. |
| `create_snapshot` | `POST /nodes/{node}/qemu/{vmid}/snapshot` | Creates a snapshot with `snapname`. | Preview lists intended snapshot name. 【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L493-L533】 | qemu only. |
| `rollback_snapshot` | `POST /nodes/{node}/qemu/{vmid}/snapshot/{name}/rollback` | Rolls back to a snapshot. | Preview shows target snapshot. 【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L533-L571】 | qemu only. |
| `clone_vm` | `POST /nodes/{node}/qemu/{vmid}/clone` | Clones VM to `newid`. | Preview includes new VMID. 【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L573-L621】 | Requires `newVmid`. |
| `migrate_vm` | `POST /nodes/{node}/qemu/{vmid}/migrate` | Live/offline migrate to `target` after pre-flight checks. | Preview includes target node and pre-flight summary. 【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L623-L699】 | Blocks if pre-flight checks fail; stores check results. 【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L699-L741】 |

### Safety and execution rules

- Every write action captures a `preWriteState` hash before the API call to aid rollback/context. 【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L252-L571】
- `dryRun: true` never hits the Proxmox API; it returns a structured diff preview so the user can review the intended change. 【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L252-L354】【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L493-L571】
- Migration runs resource/HA checks on source and target nodes before proceeding; failures return `migration_unsafe` with details instead of attempting the move. 【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L623-L741】
- Confirmation is enforced by the platform: the tool definitions mark all write actions as `requiresConfirmation: true` and limit ACLs to `admin`/`ops`. 【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L21-L77】

### When to use the write tool

- After resolving `vmid`, `node`, and `type` via `proxmox_readonly` (typically with `cluster_resources` and `get_vm_status`).
- Prefer `dryRun: true` to surface the proposed change and pre-flight results before requesting confirmation.
- Avoid `reset_vm` for containers—use `stop_vm`/`start_vm` instead. 【F:src/tools/proxmox/writes/proxmox-write-tool.ts†L451-L491】

