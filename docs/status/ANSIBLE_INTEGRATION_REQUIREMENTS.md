# Ansible Integration Requirements

## Overview

Integrate Ansible into the Action Layer to enable post-provisioning configuration management. This allows the agent to install software, configure services, and manage OS-level settings on VMs after they're created.

## Current State

### ✅ What Exists

1. **AnsibleRunner** (`src/actions/helpers/ansible-runner.ts`)
   - Basic playbook execution
   - Ad-hoc command support
   - Ping/connectivity testing

2. **Playbooks** (`lab-infra/ansible/playbooks/`)
   - `common.yml` - Complete system setup (security + Docker)
   - `hardening.yml` - Security hardening only
   - `docker.yml` - Docker installation only
   - `hostname.yml` - Hostname configuration fallback

3. **Inventory System**
   - Terraform generates `inventory.ini` automatically
   - Format: `{vm-name}.prox ansible_host={vm-name}.prox ansible_user=ops`
   - Group: `[lab_vms]`

4. **Infrastructure**
   - SSH keys configured via cloud-init
   - User: `ops` (with sudo access)
   - DNS: `.prox` domain resolution

## Requirements

### 1. Action Layer Integration

#### 1.1 Service Installation Actions

**Priority: High**

Create actions for common service installations:

- `services.install_docker` - Install Docker + Portainer
- `services.install_nginx` - Install and configure nginx
- `services.install_wazuh_agent` - Install Wazuh security agent
- `services.install_fail2ban` - Install fail2ban (or use hardening playbook)

**Parameters:**
```typescript
{
  vmName: string;        // VM name (e.g., "dad") or hostname (e.g., "dad.prox")
  playbook?: string;     // Optional: custom playbook path
  extraVars?: object;    // Optional: additional variables
  waitForVm?: boolean;   // Wait for VM to be SSH-accessible (default: true)
  timeout?: number;      // SSH wait timeout in seconds (default: 300)
}
```

**Behavior:**
1. Resolve VM name to hostname (add `.prox` if needed)
2. Check if VM exists in twin
3. Wait for SSH accessibility (ping test)
4. Run appropriate playbook with `--limit {hostname}`
5. Parse output for success/failure
6. Return structured result

#### 1.2 Configuration Actions

**Priority: Medium**

- `services.configure_firewall` - Configure UFW rules
- `services.set_static_ip` - Configure static IP via netplan
- `services.bootstrap` - Run full bootstrap (common.yml)

**Parameters:**
```typescript
{
  vmName: string;
  // For firewall:
  rules?: Array<{port: number, protocol: 'tcp'|'udp', action: 'allow'|'deny'}>;
  // For static IP:
  ip?: string;
  gateway?: string;
  netmask?: string;
}
```

#### 1.3 Ad-Hoc Operations

**Priority: Low**

- `services.run_command` - Execute arbitrary Ansible module on VM
- `services.check_status` - Check service/package status

### 2. Inventory Management

#### 2.1 Dynamic Inventory Resolution

**Requirement:** Automatically resolve VM names to Ansible inventory entries.

**Implementation:**
- Query twin for VM by name
- Extract hostname (e.g., `dad.prox`)
- Verify inventory file contains entry
- If missing, trigger Terraform inventory regeneration (or warn)

#### 2.2 Inventory Refresh

**Requirement:** Ensure inventory is up-to-date before Ansible operations.

**Options:**
1. **Auto-refresh** - Always regenerate before Ansible (slower, always accurate)
2. **On-demand** - Only refresh if VM not found (faster, may be stale)
3. **Manual trigger** - User must explicitly refresh (fastest, most control)

**Recommendation:** Option 2 (on-demand) with warning if inventory is stale.

### 3. VM Readiness Detection

#### 3.1 SSH Connectivity Check

**Requirement:** Wait for VM to be SSH-accessible before running Ansible.

**Implementation:**
```typescript
async waitForSshAccessible(hostname: string, timeout: number = 300): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout * 1000) {
    const result = await ansibleRunner.ping(inventory, `--limit ${hostname}`);
    if (result) return true;
    await sleep(5000); // Check every 5 seconds
  }
  return false;
}
```

**Considerations:**
- Cloud-init typically takes 2-3 minutes
- Some VMs may take longer (slow boot, network issues)
- Should be configurable timeout
- Should log progress

#### 3.2 VM State Validation

**Requirement:** Verify VM is running before attempting Ansible operations.

**Implementation:**
- Query twin or Proxmox API for VM state
- Only proceed if VM is `running`
- If not running, optionally start VM and wait

### 4. Error Handling & Reporting

#### 4.1 Structured Results

**Requirement:** Return detailed, structured results from Ansible operations.

```typescript
interface AnsibleActionResult {
  success: boolean;
  vmName: string;
  hostname: string;
  playbook?: string;
  changed: boolean;        // Were changes made?
  failed: boolean;         // Did it fail?
  tasksChanged: number;    // How many tasks changed
  tasksFailed: number;    // How many tasks failed
  stdout: string;         // Full output
  stderr: string;         // Error output
  duration: number;       // Execution time in ms
  errors?: string[];       // Parsed error messages
}
```

#### 4.2 Common Error Scenarios

1. **VM not found** - VM doesn't exist in twin/inventory
2. **SSH timeout** - VM not accessible after timeout
3. **Playbook not found** - Playbook file doesn't exist
4. **Ansible syntax error** - Invalid playbook
5. **Permission denied** - SSH key/auth issues
6. **Package install failures** - Network/apt issues

**Handling:**
- Provide clear error messages
- Suggest remediation steps
- Log full output for debugging

### 5. Integration Points

#### 5.1 VM Creation Workflow

**Current:** `create_vm` → Terraform → DNS record

**Enhanced:** `create_vm` → Terraform → DNS record → (optional) Ansible bootstrap

**Options:**
1. **Automatic** - Always run `common.yml` after VM creation
2. **Flag-based** - `create_vm` accepts `bootstrap: true` parameter
3. **Separate action** - User must explicitly call `services.bootstrap` after creation

**Recommendation:** Option 2 (flag-based) - gives user control, but easy to enable.

#### 5.2 Twin Integration

**Requirement:** Track Ansible configuration state in twin.

**Considerations:**
- Should we store "last Ansible run" timestamp?
- Should we tag VMs with installed services?
- Should we track playbook execution history?

**Recommendation:** Start simple - just log to twin, add tags later if needed.

### 6. User Experience

#### 6.1 Natural Language Commands

**Examples:**
- "Install Docker on dad"
- "Set up nginx on the new VM"
- "Configure firewall rules for dad.prox"
- "Bootstrap the VM I just created"

#### 6.2 Action Tool Schema

**Add to ActionTool:**
```typescript
{
  action: "services.install_docker",
  params: {
    vmName: "dad",
    waitForVm: true
  }
}
```

#### 6.3 System Prompt Updates

**Add examples:**
- "When user asks to install software, use `services.install_*` actions"
- "Wait for VM to be SSH-accessible before running Ansible"
- "Use VM name (e.g., 'dad') or hostname (e.g., 'dad.prox')"

### 7. Implementation Phases

#### Phase 1: Core Infrastructure (MVP)
- [ ] Inventory resolution from VM name
- [ ] SSH readiness detection
- [ ] Basic playbook execution wrapper
- [ ] `services.install_docker` action
- [ ] `services.bootstrap` action (runs common.yml)

#### Phase 2: Service Actions
- [ ] `services.install_nginx`
- [ ] `services.install_wazuh_agent`
- [ ] `services.configure_firewall`
- [ ] `services.set_static_ip`

#### Phase 3: Advanced Features
- [ ] Ad-hoc command execution
- [ ] Custom playbook support
- [ ] Twin state tracking
- [ ] Playbook execution history

### 8. Technical Considerations

#### 8.1 Ansible Installation

**Requirement:** Ansible must be installed on the control plane.

**Check:**
- Is Ansible installed? (`ansible --version`)
- What version? (Recommend 2.9+ or 6.0+)
- Are required collections installed?

#### 8.2 SSH Key Management

**Requirement:** SSH keys must be configured for `ops` user.

**Current:** Cloud-init configures SSH keys from `SSH_PUBLIC_KEY` env var.

**Considerations:**
- Key must be in `~/.ssh/id_rsa` or `~/.ssh/id_ed25519`
- Or use `ansible_ssh_private_key_file` in inventory
- May need to support multiple keys for different users

#### 8.3 Inventory File Location

**Current:** `lab-infra/ansible/inventory.ini`

**Considerations:**
- Should be relative to project root
- May need to support multiple environments
- Should auto-generate if missing

#### 8.4 Playbook Path Resolution

**Current:** `lab-infra/ansible/playbooks/{playbook}.yml`

**Considerations:**
- Should support absolute paths
- Should validate playbook exists before execution
- Should support custom playbook directories

### 9. Testing Strategy

#### 9.1 Unit Tests
- Inventory resolution logic
- SSH readiness detection
- Result parsing

#### 9.2 Integration Tests
- Full playbook execution on test VM
- Error handling scenarios
- Timeout handling

#### 9.3 Manual Testing
- Create VM → Install Docker → Verify
- Install nginx → Check service status
- Handle SSH timeout gracefully

### 10. Open Questions

1. **Should we auto-bootstrap VMs after creation?**
   - Pro: VMs are immediately usable
   - Con: Slower VM creation, may fail silently

2. **How to handle playbook failures?**
   - Retry automatically?
   - Notify user?
   - Rollback? (probably not)

3. **Should we support custom playbooks?**
   - Pro: Maximum flexibility
   - Con: Security/complexity concerns

4. **How to handle multiple VMs?**
   - Run playbook on all VMs?
   - Parallel execution?
   - Sequential with progress?

5. **Inventory refresh strategy?**
   - Auto-refresh vs on-demand vs manual

## Next Steps

1. **Review & Approve Requirements** - Confirm approach and priorities
2. **Design Action Schemas** - Define exact parameter structures
3. **Implement Phase 1** - Core infrastructure + Docker install
4. **Test with Real VM** - Validate end-to-end workflow
5. **Iterate** - Add more service actions based on feedback

---

**Status:** Requirements Gathering
**Last Updated:** 2025-12-01
**Owner:** Action Layer Team

