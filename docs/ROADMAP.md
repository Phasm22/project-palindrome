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

---

## PHASE 5 — ACTION LAYER 🚀

**Goal:** Enable safe automation - "Create VM named X on node Y, give it IP Z, put it in VLAN 50"

### 5.1 Proxmox Actions (High Priority)

**Current Status:**
- ✅ `proxmox_write` has: start, stop, shutdown, reboot, reset, snapshot, rollback, clone, migrate, destroy

**Missing Operations:**
- ❌ `create_vm` - Create new VM from template or ISO
  - Parameters: node, name, template/ISO, resources (CPU, memory, disk), network config
  - Validation: Check node exists, resources available, template/ISO exists
  - Twin update: Create ComputeVM entity after creation
  
- ❌ `set_vm_resources` - Configure CPU/memory/disk
  - Parameters: vmid, node, cpu, memory, disk
  - Validation: Check node has resources, VM exists
  
- ❌ `attach_vlan` - Attach VM to VLAN
  - Parameters: vmid, node, vlan_id, interface
  - Validation: Check VLAN exists in twin, VM exists
  
- ❌ `set_vm_ip` - Configure VM network/IP
  - Parameters: vmid, node, ip, subnet, gateway
  - Validation: Check subnet exists, IP available, gateway valid

**Implementation Notes:**
- Extend `proxmox_write` tool with new actions
- Add twin-grounded validation (check node/VLAN exists before creating)
- Update twin after successful operations
- Support dry-run mode for all operations

**Priority:** HIGH - This is the core automation capability

---

### 5.2 Network Actions

**Current Status:**
- ✅ Network query operations exist

**Missing Operations:**
- ❌ `set_interface_vlan` - Configure interface VLAN
  - Parameters: node, interface, vlan_id
  - Validation: Check node exists, interface exists, VLAN exists
  
- ❌ `create_vlan` - Create new VLAN
  - Parameters: vlan_id, name, subnet
  - Validation: Check VLAN doesn't exist, subnet valid
  
- ❌ `assign_static_ip` - Assign static IP to interface
  - Parameters: node, interface, ip, subnet, gateway
  - Validation: Check IP available, subnet exists, gateway valid
  
- ❌ `create_dhcp_reservation` - Create DHCP reservation (OPTIONAL)
  - Parameters: mac, ip, hostname
  - Validation: Check MAC valid, IP available, not conflicting
  - Note: Only needed if using DHCP with guaranteed IPs. If using static IPs (cloud-init/Ansible), skip this.

- ❌ `create_dns_record` - Create DNS A/AAAA record (pihole/unbound)
  - Parameters: hostname, ip, domain (optional, defaults to .prox)
  - Validation: Check hostname valid, IP valid, no conflicts
  - Implementation: Pi-hole API or unbound config management
  - Note: Unbound forwards to pihole, so pihole API is primary interface
  - **Naming convention**: Use DNS names as primary identifier (e.g., `web-server.prox` instead of IP)

**Implementation Notes:**
- OPNsense + Proxmox both contribute here
- Use `opnsense_safewrite` for OPNsense operations (DHCP reservations - optional)
- Use `pihole_api` or `dns_mcp` tool for DNS operations (HIGH priority)
- Use `proxmox_write` for Proxmox network config
- Update twin after successful operations
- **Recommended workflow**: 
  - Option A (Static IPs): Create VM → Set static IP (cloud-init/Ansible) → Create DNS record (pihole)
  - Option B (DHCP with reservations): Create VM → Create DHCP reservation (OPNsense) → Create DNS record (pihole)

**Priority:** HIGH - Needed for "put VM in VLAN 50" type operations
**DNS Priority:** HIGH - Critical for naming convention-based workflow. DNS names are primary identifier.
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

### 5.4 Bootstrap Actions (Optional)

**Current Status:**
- ❌ No bootstrap script system

**Missing Operations:**
- ❌ `install_docker` - Install docker on VM
- ❌ `install_nginx` - Install nginx on VM
- ❌ `install_wazuh_agent` - Install Wazuh agent
- ❌ `install_fail2ban` - Install fail2ban
- ❌ Generic script execution framework

**Implementation Notes:**
- Create bootstrap script framework
- Support SSH-based script execution
- Support cloud-init for VM creation
- Store scripts in templates directory

**Priority:** MEDIUM - Nice-to-have for complete automation

---

## PHASE 6 — SAFETY LAYER 🛡️

**Goal:** Simple safety checks before any modification - no complex simulation, just basic validation

### Safety Checks Before Any Modification

#### 1. Twin-Grounding
- ✅ Does the node exist? (Query twin)
- ✅ Does VLAN exist? (Query twin)
- ✅ Is VM name valid? (Check naming conventions)
- ✅ Does subnet exist? (Query twin)
- ✅ Does interface exist? (Query twin)

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

### 2. Build VM Create Flow (Next)
- This is the flagship demo
- "Create VM named X on node Y"
- "Give it IP address Z"
- "Put it in VLAN 50"

### 3. Build Network Operations
- Needed for VM creation to be useful
- VLAN + IP manipulation

### 4. Build Firewall Actions
- Once VM creation works cleanly
- Port management

### 5. Build Safety Layer
- Twin-grounded validation
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

**Last Updated:** 2025-11-27

