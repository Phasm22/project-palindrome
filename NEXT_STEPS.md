# Next Steps After Action Layer & UI Merge

**Status:** ✅ Action Layer foundation complete, ✅ Agent UI Experience merged

---

## ✅ What's Been Completed

### Action Layer (Phase 5 Foundation)
- ✅ **VM Creation** (`compute.create_vm`) - Create VMs via Terraform with twin validation
- ✅ **VM Destruction** (`compute.destroy_vm`) - Destroy VMs via Terraform
- ✅ **DNS Operations** (`network.create_dns_record`) - Create DNS A records in Pi-hole
- ✅ **DHCP Sync** (`network.sync_dhcp_to_dns`) - Sync OPNsense DHCP leases to Pi-hole DNS
- ✅ **Service Actions**:
  - `services.bootstrap` - Ansible bootstrap playbook
  - `services.install_docker` - Install Docker/Portainer
  - `services.install_nginx` - Install nginx
  - `services.configure_firewall` - Configure UFW
  - `services.set_static_ip` - Configure static IP via netplan

### Agent UI Experience
- ✅ Mobile responsiveness
- ✅ Accessibility improvements
- ✅ Logo integration
- ✅ iOS-like chat interface
- ✅ Dashboard polish

---

## 🚀 What's Next (Priority Order)

Based on `docs/ROADMAP.md`, here's the implementation order:

### 1. **Network Operations** (HIGH PRIORITY) 🔥

**Goal:** Enable "put VM in VLAN 50" type operations

**Missing Actions:**
- ❌ `network.set_interface_vlan` - Configure interface VLAN
  - Parameters: node, interface, vlan_id
  - Validation: Check node exists, interface exists, VLAN exists in twin
  - Implementation: Proxmox API or Terraform

- ❌ `network.create_vlan` - Create new VLAN
  - Parameters: vlan_id, name, subnet
  - Validation: Check VLAN doesn't exist, subnet valid
  - Implementation: OPNsense or Proxmox bridge config

- ❌ `network.assign_static_ip` - Assign static IP to interface (network-level)
  - Parameters: node, interface, ip, subnet, gateway
  - Validation: Check IP available, subnet exists, gateway valid
  - Note: `services.set_static_ip` exists for VM-level config, but network-level action needed

- ❌ `network.create_dhcp_reservation` - Create DHCP reservation (OPTIONAL)
  - Parameters: mac, ip, hostname
  - Priority: LOW (only needed if using DHCP with guaranteed IPs)
  - Implementation: OPNsense API

**Why This Matters:**
- VM creation works, but can't configure network placement
- Needed for complete "Create VM → Configure Network → DNS" workflow
- Enables "put VM in VLAN 50" natural language commands

---

### 2. **Firewall Actions** (HIGH PRIORITY) 🔥

**Goal:** Enable "open port 8080" type operations

**Missing Actions:**
- ❌ `firewall.allow_port` - Allow port through firewall
  - Parameters: port, protocol, source, destination, interface
  - Validation: Check interface exists, no conflicting rules
  - Implementation: Enhance `opnsense_safewrite` tool

- ❌ `firewall.block_port` - Block port through firewall
  - Parameters: port, protocol, source, destination, interface
  - Validation: Check interface exists

- ❌ `firewall.expose_service` - Expose service to WAN/LAN
  - Parameters: service_name, port, protocol, target_ip, target_port
  - Validation: Check target exists, port available

- ❌ `firewall.open_port_on_vlan` - Open port on specific VLAN
  - Parameters: vlan_id, port, protocol
  - Validation: Check VLAN exists in twin

- ❌ `firewall.create_firewall_rule` - Create custom firewall rule
  - Parameters: action, direction, interface, protocol, source, destination, ports
  - Validation: Check interface exists, no conflicts

- ❌ `firewall.delete_firewall_rule` - Delete firewall rule
  - Parameters: rule_id or rule description
  - Validation: Check rule exists, not a built-in rule

**Implementation Notes:**
- Enhance `opnsense_safewrite` tool with firewall operations
- Use twin to validate interfaces/VLANs before creating rules
- Update twin after successful operations
- Support dry-run mode

---

### 3. **VM Resource Management** (MEDIUM PRIORITY)

**Missing Actions:**
- ❌ `compute.set_vm_resources` - Configure CPU/memory/disk
  - Parameters: vmid, node, cpu, memory, disk
  - Validation: Check node has resources, VM exists
  - Implementation: Proxmox API or Terraform

- ❌ `compute.attach_vlan` - Attach VM to VLAN
  - Parameters: vmid, node, vlan_id, interface
  - Validation: Check VLAN exists in twin, VM exists
  - Note: Overlaps with `network.set_interface_vlan` but VM-specific

- ❌ `compute.set_vm_ip` - Configure VM network/IP
  - Parameters: vmid, node, ip, subnet, gateway
  - Validation: Check subnet exists, IP available, gateway valid
  - Note: `services.set_static_ip` exists, but compute-level action may be needed

---

### 4. **Safety Layer** (HIGH PRIORITY) 🛡️

**Goal:** Simple safety checks before any modification

**Components:**
1. **Twin-Grounding** ✅ (Partially implemented)
   - ✅ Does the node exist? (Query twin)
   - ✅ Does VLAN exist? (Query twin)
   - ✅ Is VM name valid? (Check naming conventions)
   - ✅ Does subnet exist? (Query twin)
   - ✅ Does interface exist? (Query twin)

2. **Exposure Warnings** ❌
   - ⚠️ "This rule will expose this VM to WAN."
   - ⚠️ "This VM is on VLAN 1, which is unsafe."
   - ⚠️ "Opening port 22 here conflicts with rule 5."
   - ⚠️ "This subnet is already exposed to WAN."

3. **Resource Validation** ❌
   - ⚠️ "This node has only 1GB free RAM."
   - ⚠️ "This node has no available disk space."
   - ⚠️ "This node is at 95% CPU capacity."

4. **Undo Path** ❌
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

---

### 5. **Agent Experience** (MEDIUM PRIORITY) 🎯

**Goal:** "Cursor-like" feel - quick commands, terminal augmentations

**Features:**
- ❌ Quick Commands: `agent "create vm sentinel-test on yin"`
- ❌ Terminal Augmentations: Auto-complete for VM names, node names, VLANs
- ❌ File Generation: Generate cloud-init configs, firewall rule configs
- ❌ "Do the Thing" Workflows: Single command → multiple operations

**Priority:** MEDIUM - Polish and UX improvements

---

## 📋 Recommended Implementation Order

1. **Network Operations** (Next Sprint)
   - Start with `network.set_interface_vlan` (most commonly needed)
   - Then `network.create_vlan` (enables VLAN management)
   - Then `network.assign_static_ip` (completes network config)

2. **Firewall Actions** (After Network Ops)
   - Start with `firewall.allow_port` (most common use case)
   - Then `firewall.expose_service` (higher-level abstraction)
   - Then remaining firewall operations

3. **Safety Layer** (Parallel with above)
   - Add exposure warnings to existing actions
   - Add resource validation to VM creation
   - Implement undo path tracking

4. **VM Resource Management** (Lower Priority)
   - Can be done after core network/firewall operations

5. **Agent Experience** (Polish)
   - Can be done incrementally as features stabilize

---

## 🎯 Immediate Next Steps

1. **Review current action implementations** to understand patterns
2. **Start with `network.set_interface_vlan`** - simplest network operation
3. **Add twin validation** - check VLAN exists before setting
4. **Test end-to-end**: Create VM → Set VLAN → Verify in twin
5. **Iterate**: Add remaining network operations

---

## 📚 Reference Files

- **Roadmap**: `docs/ROADMAP.md` (lines 52-173)
- **Action Registry**: `src/actions/registry.ts`
- **VM Creation Example**: `src/actions/compute/create-vm.ts`
- **DNS Example**: `src/actions/network/create-dns-record.ts`
- **Safety Layer Spec**: `docs/ROADMAP.md` (lines 198-236)

---

**Last Updated:** After action-layer and agent-ui-experience merge

