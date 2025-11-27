# Lab Infrastructure Integration Summary

## Overview

The `lab-infra` repository (git@github.com:Phasm22/lab-infra.git) is a well-structured IaC solution using Terraform + Ansible for Proxmox VM lifecycle management. This is **perfect** for the Action Layer - instead of building everything from scratch, we integrate this existing, tested infrastructure.

---

## Repository Analysis

### Structure

```
lab-infra/
├── terraform/              # Infrastructure as Code
│   ├── main.tf             # VM resources with cloud-init
│   ├── providers.tf       # bpg/proxmox provider v0.80.0
│   ├── variables.tf        # Environment variables
│   └── outputs.tf          # Dynamic inventory generation
├── ansible/                # Configuration Management
│   ├── group_vars/all.yml  # Common variables
│   └── playbooks/         # Role-based playbooks
│       ├── common.yml      # Complete system setup
│       ├── hardening.yml   # Security hardening
│       ├── docker.yml      # Docker installation
│       └── hostname.yml    # Hostname config
├── environments/          # Environment configs
│   └── ci.tfvars          # Environment variables
├── scripts/               # Automation helpers
│   ├── deploy.sh          # Deployment wrapper
│   ├── create-template.sh # Template setup
│   └── test-proxmox.sh    # API testing
└── docs/                  # Documentation
```

**Size:** ~1,100 lines of code (small, manageable)

---

## Key Capabilities

### Terraform (VM Lifecycle)

**Current Operations:**
- ✅ Create VMs from template (Ubuntu 22.04 cloud-init)
- ✅ Configure VM resources (CPU, memory, disk)
- ✅ Network configuration (DHCP-based)
- ✅ Cloud-init integration (hostname, SSH keys, packages)
- ✅ Dynamic Ansible inventory generation
- ✅ VM lifecycle management (start/stop via terraform state)

**VM Configuration:**
- Template: Ubuntu 22.04 cloud-init (template ID 9000)
- Network: DHCP-based on vmbr0
- Storage: Configurable datastore (default: local-lvm)
- Cloud-init: Full user setup, packages, services

**Provider:** `bpg/proxmox` v0.80.0 (modern Proxmox API)

### Ansible (Configuration Management)

**Current Playbooks:**
- ✅ `common.yml` - Complete system setup (security + Docker)
- ✅ `hardening.yml` - SSH, fail2ban, UFW security
- ✅ `docker.yml` - Docker + Portainer deployment
- ✅ `hostname.yml` - FQDN configuration (.prox domain)

**Capabilities:**
- System updates and package installation
- SSH security hardening (key-only auth, fail2ban)
- UFW firewall configuration
- Docker installation and Portainer deployment
- Automatic security updates

---

## Integration Strategy

### 1. Repository Placement

**Recommended:** Clone as subdirectory in Palindrome project

```
/home/tj/project-palindrome/
├── src/
├── docs/
├── lab-infra/              # <-- Clone here
│   ├── terraform/
│   ├── ansible/
│   ├── environments/
│   └── scripts/
```

**Alternative:** Keep as separate repo, reference via path

**Recommendation:** Clone into project root as `lab-infra/` - keeps everything together, easy to reference.

---

### 2. Action Layer Architecture

**New Structure:**

```
src/actions/
├── compute/
│   ├── create-vm.ts        # Wraps terraform apply
│   ├── destroy-vm.ts       # Wraps terraform destroy
│   └── set-vm-resources.ts # Wraps terraform apply (modify)
├── network/
│   └── configure-vm-network.ts  # Wraps terraform apply (network)
├── bootstrap/
│   ├── run-ansible-playbook.ts  # Wraps ansible-playbook
│   ├── install-docker.ts        # Wraps ansible docker.yml
│   └── harden-vm.ts             # Wraps ansible hardening.yml
├── helpers/
│   ├── terraform-runner.ts      # Terraform execution wrapper
│   ├── ansible-runner.ts        # Ansible execution wrapper
│   └── twin-sync.ts             # Sync terraform state → twin
└── registry.ts
```

---

### 3. Integration Points

#### A. Twin-Grounded Validation

**Before Action:**
```typescript
// In create-vm.ts
async function createVm(params: CreateVmParams) {
  // 1. Validate using twin
  const node = await twinQueryService.getNode(params.nodeName);
  if (!node) throw new Error(`Node ${params.nodeName} not found`);
  
  // 2. Check resources
  const available = await checkNodeResources(node, params);
  if (!available) throw new Error("Insufficient resources");
  
  // 3. Generate terraform config
  const tfConfig = generateTfConfig(params);
  
  // 4. Execute terraform
  await terraformRunner.apply(tfConfig);
  
  // 5. Sync to twin
  await syncTerraformStateToTwin();
}
```

#### B. Terraform Runner

**Wrapper for Terraform Operations:**
```typescript
// src/actions/helpers/terraform-runner.ts
export class TerraformRunner {
  async plan(config: TerraformConfig): Promise<PlanResult>
  async apply(config: TerraformConfig): Promise<ApplyResult>
  async destroy(config: TerraformConfig): Promise<DestroyResult>
  async output(config: TerraformConfig): Promise<OutputResult>
}
```

**Key Features:**
- Executes terraform in `lab-infra/terraform/` directory
- Uses environment-specific `.tfvars` files
- Captures stdout/stderr for error handling
- Parses terraform output for VM info
- Handles terraform state management

#### C. Ansible Runner

**Wrapper for Ansible Operations:**
```typescript
// src/actions/helpers/ansible-runner.ts
export class AnsibleRunner {
  async runPlaybook(playbook: string, inventory: string, extraVars?: Record<string, any>): Promise<PlaybookResult>
  async runAdHoc(host: string, module: string, args: Record<string, any>): Promise<AdHocResult>
}
```

**Key Features:**
- Executes ansible in `lab-infra/ansible/` directory
- Uses dynamic inventory from terraform
- Supports extra-vars for parameterization
- Captures output for error handling

#### D. Twin Sync

**Sync Terraform State → Twin:**
```typescript
// src/actions/helpers/twin-sync.ts
export async function syncTerraformStateToTwin() {
  // 1. Read terraform state/outputs
  const vms = await terraformRunner.output();
  
  // 2. Parse VM info
  const entities = parseVmInfo(vms);
  
  // 3. Upsert to twin
  await twinUpdateService.upsert(entities, relationships);
}
```

---

### 4. Required Changes (Additive Only)

#### A. Environment Configuration

**Add to `lab-infra/environments/`:**
- `palindrome.tfvars` - Palindrome-specific config
- `.env.palindrome` - API tokens (use existing Palindrome config)

**Integration:**
- Use Palindrome's existing Proxmox API tokens
- Use Palindrome's SSH keys
- Reference Palindrome's node names (proxBig, yin, yang)

#### B. Terraform Variables

**Extend `terraform/variables.tf` if needed:**
- Add variables for VLAN configuration (if not present)
- Add variables for static IP assignment (if not present)
- Keep existing variables (they're good)

#### C. Action Wrappers

**Create action wrappers that:**
- Accept natural language parameters (VM name, node, resources)
- Validate using twin
- Generate terraform config dynamically
- Execute terraform/ansible
- Sync results to twin

---

## Implementation Plan

### Phase 1: Repository Integration

1. **Clone Repository**
   ```bash
   cd /home/tj/project-palindrome
   git clone git@github.com:Phasm22/lab-infra.git lab-infra
   ```

2. **Create Palindrome Environment**
   - Create `lab-infra/environments/palindrome.tfvars`
   - Reference Palindrome's Proxmox API tokens
   - Use Palindrome's SSH keys

3. **Test Integration**
   - Run `./lab-infra/scripts/test-proxmox.sh`
   - Verify terraform can connect
   - Test a simple `terraform plan`

### Phase 2: Action Wrappers

1. **Terraform Runner**
   - Create `src/actions/helpers/terraform-runner.ts`
   - Implement plan/apply/destroy/output methods
   - Add error handling and logging

2. **Ansible Runner**
   - Create `src/actions/helpers/ansible-runner.ts`
   - Implement playbook execution
   - Add inventory management

3. **Twin Sync**
   - Create `src/actions/helpers/twin-sync.ts`
   - Parse terraform outputs
   - Upsert to twin

### Phase 3: Compute Actions

1. **Create VM Action**
   - `src/actions/compute/create-vm.ts`
   - Twin validation
   - Terraform config generation
   - Terraform apply
   - Twin sync

2. **Destroy VM Action**
   - `src/actions/compute/destroy-vm.ts`
   - Safety checks
   - Terraform destroy
   - Twin cleanup

3. **Set VM Resources**
   - `src/actions/compute/set-vm-resources.ts`
   - Modify terraform config
   - Terraform apply
   - Twin sync

### Phase 4: Bootstrap Actions

1. **Run Ansible Playbook**
   - `src/actions/bootstrap/run-ansible-playbook.ts`
   - Execute any playbook
   - Parameter support

2. **Install Docker**
   - `src/actions/bootstrap/install-docker.ts`
   - Wraps `ansible-playbook docker.yml`

3. **Harden VM**
   - `src/actions/bootstrap/harden-vm.ts`
   - Wraps `ansible-playbook hardening.yml`

---

## Key Benefits

### ✅ Leverages Existing Infrastructure
- No need to reimplement VM creation
- Tested, working terraform/ansible code
- Cloud-init integration already done
- Security hardening already implemented

### ✅ Additive Changes Only
- No breaking changes to lab-infra
- Palindrome-specific configs in separate files
- Can still use lab-infra independently

### ✅ Twin Integration
- Actions validate using twin before execution
- Actions sync results to twin after execution
- Full traceability and audit trail

### ✅ Natural Language Interface
- Agent can say "create VM sentinel-test on yin"
- Action layer translates to terraform/ansible
- Twin provides validation and context

---

## Configuration Requirements

### 1. Proxmox API Tokens

**Use Existing Palindrome Tokens:**
- Already configured in Palindrome
- Reference via environment variables
- No need to duplicate

### 2. SSH Keys

**Use Existing Palindrome Keys:**
- Already configured for VM access
- Reference via environment variables
- No need to duplicate

### 3. Node Names

**Match Palindrome's Nodes:**
- proxBig
- yin
- yang

### 4. Template ID

**Verify Template Exists:**
- Ubuntu 22.04 cloud-init template (ID 9000)
- If missing, run `./lab-infra/scripts/create-template.sh`

---

## Example Action Flow

### "Create VM named sentinel-test on yin with 2 cores, 4GB RAM"

1. **Intent Detection**
   - Agent detects: `create_vm` intent
   - Extracts: name="sentinel-test", node="yin", cores=2, memory=4GB

2. **Twin Validation**
   - Query twin: Does node "yin" exist? ✅
   - Query twin: Does VM "sentinel-test" already exist? ❌
   - Query twin: Does node "yin" have resources? ✅

3. **Generate Terraform Config**
   ```hcl
   vm_configs = {
     "sentinel-test" = {
       target_node = "yin"
       cores       = 2
       memory      = 4096
       disk_size   = "20G"
     }
   }
   ```

4. **Execute Terraform**
   ```bash
   cd lab-infra/terraform
   terraform apply -var-file="../environments/palindrome.tfvars"
   ```

5. **Sync to Twin**
   - Parse terraform output for VM info
   - Create ComputeVM entity
   - Create RUNS_ON relationship
   - Upsert to twin

6. **Optional: Run Ansible**
   - Execute `ansible-playbook common.yml` for full setup
   - Or skip for manual configuration

---

## Next Steps

1. **Clone Repository**
   - Clone into `lab-infra/` directory
   - Review structure and documentation

2. **Create Palindrome Environment**
   - Create `palindrome.tfvars`
   - Configure API tokens and SSH keys

3. **Build Terraform Runner**
   - Create helper for terraform execution
   - Add error handling and logging

4. **Build First Action**
   - Start with `create-vm` action
   - Integrate twin validation
   - Test end-to-end

5. **Extend Actions**
   - Add more compute actions
   - Add bootstrap actions
   - Add network actions (if terraform supports)

---

## Questions to Resolve

1. **Repository Location**
   - Clone into project? ✅ (Recommended)
   - Or reference external path?

2. **Terraform State Management**
   - Use local state? (Simple)
   - Or remote backend? (Better for team)

3. **Ansible Inventory**
   - Use terraform-generated inventory? ✅ (Current approach)
   - Or generate from twin?

4. **Network Configuration**
   - Does terraform support VLAN assignment?
   - Does terraform support static IP?
   - Or need to extend terraform?

5. **Firewall Actions**
   - Terraform doesn't handle firewall rules
   - Need separate OPNsense actions
   - Or extend terraform with OPNsense provider?

---

## Summary

The `lab-infra` repository is **perfect** for the Action Layer:

- ✅ **Small & Manageable** (~1,100 lines)
- ✅ **Well-Structured** (terraform + ansible)
- ✅ **Well-Documented** (good READMEs)
- ✅ **Tested** (working CI/CD pipeline)
- ✅ **Additive Changes Only** (no breaking changes needed)

**Integration Approach:**
1. Clone into project as `lab-infra/`
2. Create action wrappers that call terraform/ansible
3. Add twin validation before actions
4. Sync results to twin after actions
5. Provide natural language interface via agent

**This is exactly the right approach - leverage existing infrastructure instead of rebuilding everything!**

---

**Last Updated:** 2025-11-27

