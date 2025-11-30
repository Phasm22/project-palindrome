# Control Plane Architecture Guide

## Overview

This document explains **where** to control different operations and **why**, following industry best practices for Infrastructure as Code (IaC) and layered defense.

## Core Principle: Separation of Concerns

```
┌─────────────────────────────────────────────────────────┐
│                    User Intent                           │
│  "Create VM X, give it IP Y, put it in VLAN 50"        │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│              LLM Agent (Orchestrator)                   │
│  - Interprets intent                                    │
│  - Queries twin for current state                       │
│  - Plans changes across control planes                  │
└─────┬──────────────┬──────────────┬─────────────────────┘
      │              │              │
      ▼              ▼              ▼
┌──────────┐  ┌──────────┐  ┌──────────┐
│Terraform │  │ Ansible  │  │ OPNsense │
│ (Infra)  │  │ (Config) │  │ (Network)│
└──────────┘  └──────────┘  └──────────┘
```

## Control Plane Mapping

### 1. Terraform (Infrastructure Layer)
**What it controls:** Physical/logical infrastructure resources

**Operations:**
- ✅ `create_vm` / `delete_vm` - VM lifecycle
- ✅ `start_vm` / `stop_vm` - Power operations (via Terraform state)
- ✅ `attach_vlan` - Network bridge/VLAN assignment at VM level
- ✅ `set_vm_resources` - CPU, memory, disk sizing
- ❌ `clone` - Defer (no NAS yet, local-to-local not worth it)
- ❌ `set_ip` - Use Ansible/cloud-init (see below)
- ❌ `assign_static_ip` - Use OPNsense DHCP reservations (see below)

**Why Terraform:**
- **Idempotent**: Same config = same result every time
- **Stateful**: Tracks what exists vs. what should exist
- **Reviewable**: `terraform plan` shows exact changes before apply
- **Version controlled**: All changes in Git, PR-based workflow

**Example:**
```hcl
# terraform/main.tf
resource "proxmox_virtual_environment_vm" "my_vm" {
  name      = "my-vm"
  node_name = "yang"
  vm_id     = 200
  
  # Infrastructure concerns
  cpu {
    cores = 2
  }
  memory {
    dedicated = 4096
  }
  disk {
    datastore_id = "local-lvm"
    file_format  = "raw"
    size         = 20
  }
  
  # Network bridge/VLAN (infrastructure)
  network_device {
    bridge = "vmbr0"
    vlan_id = 50  # ← Infrastructure concern
  }
}
```

---

### 2. Ansible (Configuration Layer)
**What it controls:** Software, services, OS-level configuration

**Operations:**
- ✅ `install_nginx` - Service installation
- ✅ `install_docker` - Container runtime
- ✅ `install_wazuh-agent` - Security agent
- ✅ `set_ip` - Static IP configuration (via cloud-init or Ansible)
- ✅ `configure_firewall` - VM-level firewall (UFW, iptables)
- ✅ `bootstrap_scripts` - Post-provision setup

**Why Ansible:**
- **Declarative config**: "nginx should be installed and running"
- **Idempotent**: Safe to run multiple times
- **Agentless**: No daemon needed on target VMs
- **Role-based**: Reusable playbooks (nginx, docker, wazuh)
- **Inventory-driven**: Automatically targets VMs from Terraform

**Example:**
```yaml
# ansible/playbooks/nginx.yml
- name: Install and configure nginx
  hosts: web_servers
  tasks:
    - name: Install nginx
      apt:
        name: nginx
        state: present
    
    - name: Configure static IP
      template:
        src: netplan-static.j2
        dest: /etc/netplan/50-cloud-init.yaml
      vars:
        ip_address: "172.16.0.100"
        gateway: "172.16.0.1"
```

---

### 3. OPNsense (Network/Firewall Layer)
**What it controls:** Network routing, DHCP, firewall rules

**Operations:**
- ✅ `assign_static_ip` - DHCP reservations
- ✅ `create_dhcp_reservation` - MAC → IP mapping
- ✅ `allow_port` / `block_port` - Firewall rules
- ✅ `expose_service` - Port forwarding / NAT rules
- ✅ `view_rules` - Firewall rule queries
- ✅ `set_interface_vlan` - Physical interface VLAN tagging (if needed)

**Why OPNsense (not Terraform/Ansible):**
- **Network control plane**: OPNsense IS your network router/firewall
- **DHCP server**: Centralized IP management
- **Firewall rules**: Network-level security (defense in depth)
- **Stateful**: Tracks connections, sessions, leases

**When to use `opnsense_safewrite` vs. Terraform:**
- **Use `opnsense_safewrite`**: Temporary rules, emergency changes, surgical updates
- **Use Terraform (future)**: If you model OPNsense config in Terraform (advanced)
- **Current approach**: Direct API calls for network/firewall, log to twin

**Example:**
```typescript
// Via opnsense_safewrite tool
{
  action: "create_dhcp_reservation",
  mac: "aa:bb:cc:dd:ee:ff",
  ip: "172.16.0.100",
  hostname: "my-vm"
}
```

---

## Industry Best Practices

### 1. **Layered Defense (Defense in Depth)**

```
┌─────────────────────────────────────┐
│  Layer 1: Network Firewall (OPNsense)│  ← Block at network edge
├─────────────────────────────────────┤
│  Layer 2: VM Firewall (Ansible/UFW) │  ← Block at host level
├─────────────────────────────────────┤
│  Layer 3: Application Security      │  ← Application-level controls
└─────────────────────────────────────┘
```

**How to implement:**
- **Network layer**: OPNsense firewall rules (allow/block ports)
- **VM layer**: Ansible configures UFW/iptables on each VM
- **Application layer**: Service-specific security (nginx ACLs, etc.)

**Example workflow:**
1. Terraform creates VM with VLAN 50
2. OPNsense allows port 80/443 to VLAN 50 (network layer)
3. Ansible installs nginx and configures UFW (VM layer)
4. Nginx config restricts access (application layer)

---

### 2. **Infrastructure vs. Configuration Separation**

**Terraform (Infrastructure):**
- VM exists? ✅
- VM has CPU/memory? ✅
- VM connected to network bridge? ✅
- VM in correct VLAN? ✅

**Ansible (Configuration):**
- VM has IP address? ✅
- VM has nginx installed? ✅
- VM has firewall rules? ✅
- VM has monitoring agent? ✅

**Why separate:**
- **Terraform**: Fast, idempotent, stateful - perfect for resource lifecycle
- **Ansible**: Flexible, role-based, inventory-driven - perfect for software/config
- **Separation**: Can destroy/recreate VM (Terraform) without losing config knowledge (Ansible playbooks)

---

### 3. **State Management**

**Terraform State:**
- Tracks: What VMs exist, their IDs, resources, network attachments
- Source of truth: `terraform.tfstate` (or remote state)
- Query: "What VMs are defined in Terraform?"

**Digital Twin (Neo4j):**
- Tracks: What VMs actually exist (from Proxmox API), their IPs, relationships
- Source of truth: Live Proxmox/OPNsense state (via parsers)
- Query: "What VMs are actually running right now?"

**Ansible Inventory:**
- Tracks: What VMs need configuration, their groups, variables
- Source of truth: Generated from Terraform outputs
- Query: "What VMs should get nginx installed?"

**Best practice:** Always query twin before acting, validate against Terraform state

---

## Operation Mapping

### VM Operations

| Operation | Control Plane | Why |
|-----------|--------------|-----|
| `create_vm` | Terraform | Infrastructure resource |
| `delete_vm` | Terraform | Infrastructure resource |
| `start_vm` / `stop_vm` | Terraform (or `proxmox_write` for emergency) | State management |
| `clone` | Defer (no NAS) | Not worth local-to-local |
| `set_vm_resources` | Terraform | Infrastructure sizing |
| `attach_vlan` | Terraform | Network bridge/VLAN (infrastructure) |

### Network Operations

| Operation | Control Plane | Why |
|-----------|--------------|-----|
| `set_interface_vlan` | OPNsense (if physical) / Terraform (if VM) | Network control plane |
| `assign_static_ip` | OPNsense (DHCP reservation) OR Ansible/cloud-init (static) | IP assignment strategy |
| `create_dhcp_reservation` | OPNsense (OPTIONAL) | Only if using DHCP with guaranteed IPs |
| `create_dns_record` | Pi-hole API / Unbound config | **HIGH PRIORITY** - DNS names are primary identifier |
| `set_ip` (on VM) | Ansible/cloud-init | OS-level configuration (static IPs) |

### Firewall Operations

| Operation | Control Plane | Why |
|-----------|--------------|-----|
| `allow_port` | OPNsense | Network firewall (Layer 1) |
| `block_port` | OPNsense | Network firewall (Layer 1) |
| `expose_service` | OPNsense | NAT/port forwarding |
| `view_rules` | OPNsense (read-only) | Query firewall state |
| VM firewall rules | Ansible (UFW/iptables) | Host firewall (Layer 2) |

### Bootstrap Operations

| Operation | Control Plane | Why |
|-----------|--------------|-----|
| `install_nginx` | Ansible | Software installation |
| `install_docker` | Ansible | Software installation |
| `install_wazuh-agent` | Ansible | Security agent |
| `bootstrap_scripts` | Ansible | Post-provision setup |

---

## Recommended Workflow

### Example: "Create VM X, give it IP Y, put it in VLAN 50, install nginx"

**Step 1: Terraform (Infrastructure)**
```hcl
resource "proxmox_virtual_environment_vm" "x" {
  name      = "x"
  node_name = "yang"
  vm_id     = 200
  
  network_device {
    bridge  = "vmbr0"
    vlan_id = 50  # ← Infrastructure: VM in VLAN 50
  }
  
  # Cloud-init for initial IP (or use Ansible)
  initialization {
    ip_config {
      ipv4 {
        address = "172.16.50.100/24"  # ← Can set here or via Ansible
        gateway = "172.16.50.1"
      }
    }
  }
}
```

**Step 2: DNS (Pi-hole)**
```typescript
// Create DNS A record (HIGH PRIORITY - DNS names are primary identifier)
await piholeApi.createDnsRecord({
  hostname: "x",
  ip: "172.16.50.100",
  domain: "prox"  // Creates x.prox → 172.16.50.100
});

// Optional: Create DHCP reservation (only if using DHCP, not needed with static IPs)
// await opnsenseSafewrite.createDhcpReservation({...});
```

**Step 3: OPNsense (Network Firewall)**
```typescript
// Allow port 80/443 to VLAN 50 (network firewall)
await opnsenseSafewrite.allowPort({
  port: [80, 443],
  protocol: "tcp",
  destination: "172.16.50.0/24"  // VLAN 50 subnet
});
```

**Step 4: Ansible (Configuration)**
```yaml
# ansible/playbooks/nginx.yml
- name: Install nginx on web servers
  hosts: web_servers
  tasks:
    - name: Install nginx
      apt:
        name: nginx
        state: present
    
    - name: Configure UFW (VM firewall)
      ufw:
        rule: allow
        port: "{{ item }}"
        proto: tcp
      loop: [80, 443]
```

---

## Decision Matrix

**When to use Terraform:**
- ✅ Resource lifecycle (create/destroy)
- ✅ Infrastructure sizing (CPU, memory, disk)
- ✅ Network attachments (bridge, VLAN)
- ✅ Anything that should be version-controlled and reviewed

**When to use Ansible:**
- ✅ Software installation
- ✅ Service configuration
- ✅ OS-level settings
- ✅ Post-provision setup
- ✅ Anything that needs to run on existing VMs

**When to use OPNsense:**
- ✅ Network routing
- ✅ DHCP management (reservations - only if using DHCP)
- ✅ Network firewall rules
- ✅ Port forwarding/NAT
- ✅ Anything network-layer

**When to use Pi-hole/DNS:**
- ✅ DNS A/AAAA record creation (HIGH PRIORITY)
- ✅ DNS name as primary identifier
- ✅ Service discovery via hostnames
- ✅ DNS-based VM identification (instead of IPs)

**When to use direct tools (`proxmox_write`, `opnsense_safewrite`):**
- ✅ Emergency operations (force shutdown, reset)
- ✅ Diagnostics (why no IP?, what bridge?)
- ✅ Temporary changes (open port for testing)
- ✅ Operations that don't fit IaC model

---

## IP Assignment Strategy: Static vs DHCP Reservations

### Option A: Static IPs (Recommended for DNS-first workflow)

**How it works:**
1. Terraform/cloud-init sets static IP on VM
2. DNS record created once (hostname → IP)
3. No DHCP reservation needed

**Pros:**
- ✅ Simpler (no reservation management)
- ✅ DNS record never becomes stale
- ✅ Works perfectly with naming conventions
- ✅ IP is set at VM creation, DNS points to it

**Cons:**
- ⚠️ Need to manage IP pool manually (avoid conflicts)
- ⚠️ IP changes require VM config update

**Example:**
```hcl
# Terraform - static IP in cloud-init
ip_config {
  ipv4 {
    address = "172.16.50.100/24"
    gateway = "172.16.50.1"
  }
}
```

```typescript
// Action layer - create DNS record
await piholeApi.createDnsRecord({
  hostname: "web-server",
  ip: "172.16.50.100",
  domain: "prox"
});
// Result: web-server.prox → 172.16.50.100 (always valid)
```

### Option B: DHCP with Reservations

**How it works:**
1. VM uses DHCP (gets IP from pool)
2. DHCP reservation guarantees same IP
3. DNS record created (hostname → reserved IP)

**Pros:**
- ✅ Centralized IP management (OPNsense)
- ✅ Automatic conflict prevention
- ✅ Easy to change IP (update reservation)

**Cons:**
- ⚠️ More complex (two steps: reservation + DNS)
- ⚠️ Requires OPNsense DHCP management

**Example:**
```hcl
# Terraform - DHCP
ip_config {
  ipv4 {
    address = "dhcp"
  }
}
```

```typescript
// Action layer - reservation + DNS
await opnsenseSafewrite.createDhcpReservation({
  mac: vm.macAddress,
  ip: "172.16.50.100",
  hostname: "web-server"
});

await piholeApi.createDnsRecord({
  hostname: "web-server",
  ip: "172.16.50.100",
  domain: "prox"
});
```

### Recommendation for DNS-First Workflow

**Use Static IPs (Option A)** because:
- DNS names are your primary identifier
- Simpler workflow (one less step)
- DNS record is created once and stays valid
- Naming convention works perfectly

**Reservations are only needed if:**
- You want centralized IP management via OPNsense
- You're using DHCP and want guaranteed IPs
- You prefer DHCP flexibility over static config

---

## Future Enhancements

### Phase 1: Current (What you have)
- ✅ Terraform for VM lifecycle
- ✅ Ansible for configuration
- ✅ OPNsense API for network/firewall

### Phase 2: Network Operations (Next)
- Add `opnsense_safewrite` actions for:
  - DHCP reservations
  - Firewall rules
  - Port forwarding

### Phase 3: Safety Layer
- Twin-grounded validation
- Exposure warnings
- Resource validation
- Undo path

### Phase 4: Advanced (Future)
- Terraform provider for OPNsense (if available)
- Ansible roles for common services
- Workflow templates ("create full stack")

---

## Summary

**Control Plane Hierarchy:**
1. **Terraform** = Infrastructure (VMs, resources, network attachments)
2. **Ansible** = Configuration (software, services, OS settings)
3. **OPNsense** = Network/Firewall (routing, DHCP, firewall rules)

**Key Principle:** Each tool does what it's best at. Don't force everything into one tool.

**Your current setup is already following industry best practices!** The action layer just needs to wire up the remaining operations to the right control planes.

