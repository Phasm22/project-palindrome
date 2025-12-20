# Palindrome Development Roadmap

## Vision

**Local-first agent for homelab automation:**
- Local brain (LLM)
- Local graph (Neo4j)
- Local data (Digital Twin)
- Local logic (Reasoning Chains)
- Local tooling (Proxmox/OPNsense/SSH)
- Local control plane

**OpenAI is a "language reasoner" only** - sensitive data never leaves your network.

---

## PHASE 4 — COMPLETE ✅

### Parser Layer ✅
- ✅ Compute parsers (Proxmox VM & Node)
- ✅ Network parsers (Interface & Subnet)
- ✅ Security parsers (Firewall rules)
- ✅ Parser registry

### Twin Layer ✅
- ✅ Entity storage (ComputeVM, ComputeNode, NetworkInterface, NetworkSubnet, FirewallRule)
- ✅ Relationship storage (RUNS_ON, CONNECTS_TO, ALLOWS, BLOCKS)
- ✅ Twin query service
- ✅ Twin query tool

### Reasoning Chains ✅
- ✅ Compute chains (VM/node listing)
- ✅ Network chains (interface/subnet queries)
- ✅ Firewall chains (rule queries)
- ✅ Exposure chains (single-hop informational)

### Intent Routing ✅
- ✅ Compute intent detection
- ✅ Network intent detection
- ✅ Firewall intent detection
- ✅ Exposure intent detection

### Twin-First Queries ✅
- ✅ Compute queries (twin-first, no live API calls)
- ✅ Network queries (twin-first)
- ✅ Firewall queries (twin-first)

**Status:** Phase 4 is complete. The Parser Layer provides situational awareness. The Twin Layer provides facts. Reasoning chains provide natural language responses.

### Additional Features Built ✅

**Clarification System:**
- ✅ Rule-based typo detection (adjacent keyboard keys, Levenshtein distance)
- ✅ Entity recognition (VM names, node names, infrastructure terms)
- ✅ Multi-turn clarification with clickable suggestions
- ✅ No LLM needed - fast, deterministic corrections

**Tool Progress Events:**
- ✅ Real-time progress updates during long-running operations
- ✅ Status indicators (starting, running, waiting, verifying, completed, failed)
- ✅ Progress bars with percentage
- ✅ Visual feedback in dashboard during VM creation, terraform operations

**Environment Overview:**
- ✅ Natural language queries: "What's running on node X?", "Show me all VMs", "Overview of my environment"
- ✅ Twin-grounded responses with cluster/node/VM status
- ✅ Formatted output with running/stopped VM counts
- ✅ No action required - pure informational queries

**Multi-Cluster Support:**
- ✅ Proxmox operations work across YANG, YIN, proxBig clusters
- ✅ Automatic endpoint resolution for alternative clusters
- ✅ Node name normalization and validation
- ✅ Token management per cluster

---

## PHASE 5 — ACTION LAYER 🚀

**Goal:** Enable safe automation - "Create VM named X on node Y, give it IP Z, put it in VLAN 50"

### 5.1 Proxmox Actions (High Priority)

**Current Status:**
- ✅ `proxmox_write` has: start, stop, shutdown, reboot, reset, snapshot, rollback, clone, migrate, destroy
- ✅ `compute.create_vm` - Create new VM from template via Terraform
  - ✅ Parameters: node, name (auto-generated palindrome if not provided), template ID, resources (CPU, memory, disk), network config
  - ✅ Validation: Twin-grounded (check node exists, VM name available)
  - ✅ Twin update: Auto-syncs to twin after creation
  - ✅ Multi-cluster support: Works across YANG, YIN, proxBig clusters
  - ✅ DNS integration: Auto-creates DNS records in Pi-hole
  - ✅ Progress events: Real-time progress updates during long operations
  - ✅ VM ID allocation: Auto-allocates from 9000-9999 range
  - ✅ Node-specific templates: yang=8000, yin=8001, proxBig=8001

**Missing Operations:**
- ❌ `set_vm_resources` - Configure CPU/memory/disk on existing VM
  - Parameters: vmid, node, cpu, memory, disk
  - Validation: Check node has resources, VM exists
  
- ❌ `attach_vlan` - Attach VM to VLAN (via Terraform network config)
  - Parameters: vmid, node, vlan_id, interface
  - Validation: Check VLAN exists in twin, VM exists
  - Note: Can be done via `compute.create_vm` with `vlanId` parameter, but no update path for existing VMs
  
- ❌ `set_vm_ip` - Configure VM network/IP on existing VM
  - Parameters: vmid, node, ip, subnet, gateway
  - Validation: Check subnet exists, IP available, gateway valid
  - Note: Static IPs can be set via cloud-init during creation, but no update path

**Implementation Notes:**
- VM creation uses Terraform for deterministic operations
- Multi-cluster awareness built into both `proxmox_write` and `compute.create_vm`
- Tool progress events provide real-time feedback during long operations
- DNS names are primary identifier (e.g., `aha.prox`)

**Priority:** HIGH - Core automation capability is working, resource management still needed

---

### 5.2 Network Actions

**Current Status:**
- ✅ Network query operations exist
- ✅ VLAN query operations exist (`opnsense_readonly.interfaces_vlans_list`)
- ✅ `network.create_dns_record` - Create DNS A/AAAA record in Pi-hole
  - ✅ Parameters: hostname, ip, domain (optional, defaults to .prox)
  - ✅ Validation: Check hostname valid, IP valid, handles conflicts (updates existing)
  - ✅ Implementation: Pi-hole REST API (session-based auth)
  - ✅ Auto-integration: VM creation automatically creates DNS records
  - ✅ **Naming convention**: DNS names are primary identifier (e.g., `aha.prox`)
- ✅ `network.sync_dhcp_to_dns` - Sync OPNsense DHCP leases to Pi-hole DNS records
  - ✅ Automatically bridges OPNsense DHCP (Unbound) and Pi-hole (forwarder)
  - ✅ Updates existing DNS records if IP changed

**Strategy:** Use existing VLANs only. Creating VLANs requires orchestration across Ansible (switch), OPNsense, and Proxmox, with latency/retry complexity. For Phase 5, we'll validate existing VLANs and assign VMs to them.

**Missing Operations:**
- ❌ `set_interface_vlan` - Assign existing VM to VLAN (update path)
  - Parameters: vmid, node, vlan_id, bridge (default: vmbr0)
  - Validation: 
    - Check VLAN exists in OPNsense (query `opnsense_readonly.interfaces_vlans_list`)
    - Check VLAN exists in twin (NetworkInterface entities)
    - Check node exists, VM exists
  - Implementation: Terraform (Proxmox bridge config with `vlan_id`)
  - Note: Can be done during VM creation via `vlanId` parameter, but no update path for existing VMs
  
- ❌ `assign_static_ip` - Assign static IP to existing VM interface
  - Parameters: node, interface, ip, subnet, gateway
  - Validation: Check IP available, subnet exists, gateway valid
  - Note: Static IPs can be set via cloud-init during creation, but no update path
  
- ❌ `create_dhcp_reservation` - Create DHCP reservation in OPNsense (OPTIONAL)
  - Parameters: mac, ip, hostname
  - Validation: Check MAC valid, IP available, not conflicting
  - Note: Only needed if using DHCP with guaranteed IPs. If using static IPs (cloud-init/Ansible), skip this.

**Implementation Notes:**
- DNS operations are complete and integrated with VM creation
- OPNsense + Proxmox both contribute here
- Use `opnsense_safewrite` for OPNsense operations (DHCP reservations - optional)
- Use `proxmox_write` for Proxmox network config
- Update twin after successful operations
- **Current workflow**: Create VM (with cloud-init static IP) → Auto-create DNS record (pihole)

**Priority:** MEDIUM - DNS is done, VLAN assignment for existing VMs still needed
**DHCP Reservation Priority:** LOW - Only needed if using DHCP with guaranteed IPs. Can skip if using static IPs.

---

### 5.3 Firewall Actions

**Current Status:**
- ✅ Firewall query operations exist
- ✅ `opnsense_safewrite` exists but needs enhancement

**Missing Operations:**
- ❌ `allow_port` - Allow port through firewall
  - Parameters: port, protocol, source, destination, interface
  - Validation: Check interface exists, no conflicting rules
  
- ❌ `block_port` - Block port through firewall
  - Parameters: port, protocol, source, destination, interface
  - Validation: Check interface exists
  
- ❌ `expose_service` - Expose service to WAN/LAN
  - Parameters: service_name, port, protocol, target_ip, target_port
  - Validation: Check target exists, port available
  
- ❌ `open_port_on_vlan` - Open port on specific VLAN
  - Parameters: vlan_id, port, protocol
  - Validation: Check VLAN exists
  
- ❌ `create_firewall_rule` - Create custom firewall rule
  - Parameters: action, direction, interface, protocol, source, destination, ports
  - Validation: Check interface exists, no conflicts
  
- ❌ `delete_firewall_rule` - Delete firewall rule
  - Parameters: rule_id or rule description
  - Validation: Check rule exists, not a built-in rule

**Implementation Notes:**
- Enhance `opnsense_safewrite` with firewall operations
- Use twin to validate interfaces/VLANs before creating rules
- Update twin after successful operations
- Support dry-run mode

**Priority:** HIGH - Needed for "open port 8080" type operations

---

### 5.4 Bootstrap Actions ✅

**Current Status:**
- ✅ `services.bootstrap` - Run Ansible playbook on VM (default: common.yml)
  - ✅ Parameters: vmName, playbook, waitForVm, timeout, retryOnFailure, maxRetries
  - ✅ Implementation: Ansible via SSH
  - ✅ Auto-wait: Waits for VM to be accessible before running
- ✅ `services.install_docker` - Install Docker CE, Docker Compose, and Portainer
  - ✅ Parameters: vmName, waitForVm, timeout, retryOnFailure, maxRetries
  - ✅ Implementation: Ansible playbook
- ✅ `services.install_nginx` - Install and configure nginx web server
  - ✅ Parameters: vmName, waitForVm, timeout, retryOnFailure, maxRetries
  - ✅ Implementation: Ansible playbook
- ✅ `services.configure_firewall` - Configure UFW firewall rules on VM
  - ✅ Parameters: vmName, rules, defaultPolicy, waitForVm, timeout, retryOnFailure, maxRetries
  - ✅ Implementation: Ansible playbook
- ✅ `services.set_static_ip` - Configure static IP address on VM using netplan
  - ✅ Parameters: vmName, ip (CIDR format), gateway, dns, interface, waitForVm, timeout, retryOnFailure, maxRetries
  - ✅ Implementation: Ansible playbook

**Missing Operations:**
- ❌ `install_wazuh_agent` - Install Wazuh agent
- ❌ `install_fail2ban` - Install fail2ban
- ❌ Generic script execution framework (beyond Ansible)

**Implementation Notes:**
- Bootstrap system uses Ansible for SSH-based script execution
- Cloud-init handles initial VM setup (packages, users, SSH keys)
- Ansible handles post-creation configuration
- All services actions support dry-run mode

**Priority:** MEDIUM - Core bootstrap is done, additional services can be added as needed

---

## PHASE 6 — SAFETY LAYER 🛡️

**Goal:** Simple safety checks before any modification - no complex simulation, just basic validation

### Safety Checks Before Any Modification

#### 1. Twin-Grounding (Partially Implemented)
- ✅ Does the node exist? (Query twin) - DONE in `compute.create_vm`
- ✅ Is VM name valid? (Check naming conventions) - DONE (DNS-safe names, palindrome generation)
- ✅ Does VM already exist? (Query twin) - DONE in `compute.create_vm`
- ⚠️ Does VLAN exist? (Query twin) - Can validate during creation, but not enforced
- ⚠️ Does subnet exist? (Query twin) - Not yet implemented
- ⚠️ Does interface exist? (Query twin) - Not yet implemented

#### 2. Exposure Warnings
- ⚠️ "This rule will expose this VM to WAN."
- ⚠️ "This VM is on VLAN 1, which is unsafe."
- ⚠️ "Opening port 22 here conflicts with rule 5."
- ⚠️ "This subnet is already exposed to WAN."

#### 3. Resource Validation
- ⚠️ "This node has only 1GB free RAM."
- ⚠️ "This node has no available disk space."
- ⚠️ "This node is at 95% CPU capacity."

#### 4. Undo Path
- ✅ For every change, store:
  - Previous values
  - Instructions for rollback
  - Change timestamp
  - User who made change

**Implementation Notes:**
- Add validation functions to each action tool
- Query twin before making changes
- Emit warnings (not blockers) for unsafe operations
- Store change history in twin or separate audit log
- Provide rollback instructions in tool responses

**Priority:** HIGH - Essential for safe automation

---

## PHASE 7 — Local-First Agent Experience 🎯

**Goal:** "Cursor-like" feel - quick commands, terminal augmentations, file generation

### Features

#### 1. Quick Commands
- `agent "create vm sentinel-test on yin"`
- `agent "open port 8080 for opsbox"`
- `agent "put windowsVM in VLAN 50"`

#### 2. Terminal Augmentations
- Auto-complete for VM names, node names, VLANs
- Context-aware suggestions
- Twin-grounded autocomplete

#### 3. File Generation in Templates
- Generate cloud-init configs
- Generate firewall rule configs
- Generate network configs

#### 4. "Do the Thing" Workflows
- Single command → multiple operations
- "Create VM with full stack" → create VM + configure network + install services
- Workflow templates

**Implementation Notes:**
- Enhance CLI with autocomplete
- Create workflow engine
- Template system for common operations
- Natural language → action mapping

**Priority:** MEDIUM - Polish and UX improvements

---

## Implementation Order

### 1. Freeze Everything Except Action Layer ✅
- ✅ Parser Layer is finished
- ✅ Twin Layer is finished
- ✅ Reasoning Chains are finished
- **Stop expanding these**

### 2. Build VM Create Flow ✅
- ✅ "Create VM named X on node Y" - DONE
- ✅ "Give it IP address Z" - DONE (via cloud-init + DNS)
- ⚠️ "Put it in VLAN 50" - Partial (can set during creation, no update path)

### 3. Build Network Operations (In Progress)
- ✅ DNS operations - DONE
- ✅ DHCP→DNS sync - DONE
- ❌ VLAN assignment for existing VMs - TODO
- ❌ Static IP updates for existing VMs - TODO

### 4. Build Firewall Actions (Next)
- Once VM creation works cleanly
- Port management
- Rule creation/deletion

### 5. Build Safety Layer
- Twin-grounded validation (partially done - VM creation validates)
- Exposure warnings
- Resource validation
- Undo path

### 6. Build Agent Experience (Optional)
- Quick commands
- Terminal augmentations
- Workflows

---

## What We're NOT Building

- ❌ Multi-hop attack path analysis
- ❌ Blast radius calculations
- ❌ Risk scoring
- ❌ Complex simulation
- ❌ AI-driven orchestration logic
- ❌ Mutation chains
- ❌ Storage parsers (defer)
- ❌ Metrics parsers (defer)
- ❌ Events parsers (defer)
- ❌ Complex reasoning chains (drift analysis, change impact)

**Why:** These are over-engineering for a homelab automation assistant. We need **facts → actions**, not **facts → analysis → simulation → actions**.

---

## Key Principles

1. **Parser Layer is the spine** - provides facts
2. **Action Layer is the muscle** - does the work
3. **Safety Layer is the guardrails** - prevents mistakes
4. **Simple is better than complex** - no simulation, just validation
5. **Twin-grounded** - always check facts before acting
6. **Local-first** - everything stays on your network

---

**Last Updated:** 2025-12-06

## Current Capabilities Summary

**What You Can Do Now:**
- ✅ Query environment: "What's running on node YIN?", "Show me all VMs", "Overview of my environment"
- ✅ Create VMs: "Create a VM on node yin" (auto-generates palindrome name, creates DNS record)
- ✅ VM lifecycle: Start, stop, restart, destroy VMs across multiple Proxmox clusters
- ✅ DNS management: Create/update DNS records in Pi-hole, sync DHCP leases to DNS
- ✅ Service installation: Install Docker, nginx, configure firewall on VMs via Ansible
- ✅ Network configuration: Set static IPs, configure VLANs during VM creation
- ✅ Typo correction: Automatic clarification for common typos (e.g., "cm" → "vm")

**What's Still TODO:**
- ❌ Update existing VMs: Change VLAN, update static IP, modify resources
- ❌ Firewall write operations: Create/delete firewall rules, open/close ports
- ❌ Resource management: Adjust CPU/memory/disk on existing VMs
- ❌ Safety warnings: Exposure alerts, resource capacity warnings
- ❌ Posture checks: Drift detection, hygiene reports, readiness checks

