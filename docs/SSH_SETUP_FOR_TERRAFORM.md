# SSH Setup for Terraform Snippet Uploads

## Overview

The Proxmox Terraform provider uses **SSH** to upload cloud-init snippets to the snippets datastore. This is because the Proxmox API doesn't support direct file uploads for snippets.

## Current Issue

Terraform is failing with:
```
failed to open SSH client: unable to authenticate user "root" over SSH to "172.16.0.11:22"
```

## Solution Options

### Option 1: Use SSH Agent (Recommended for Local Development)

1. **Ensure SSH key is in agent:**
   ```bash
   ssh-add -L  # Check if keys are loaded
   ssh-add ~/.ssh/id_ed25519  # Add your key if not loaded
   ```

2. **Verify SSH access to yin:**
   ```bash
   ssh -o ConnectTimeout=5 root@172.16.0.11 "echo 'SSH works'"
   ```

3. **Terraform is already configured to use SSH agent** (`use_ssh_agent = true`)

### Option 2: Use Private Key File

If SSH agent isn't available, Terraform can use a private key file:

1. **Ensure private key exists:**
   ```bash
   ls -la ~/.ssh/id_ed25519
   ```

2. **Update Terraform to use private key instead of agent:**
   - Set `use_ssh_agent = false` in the tfvars
   - Terraform will read from `~/.ssh/id_ed25519`

### Option 3: Set up SSH Key on Proxmox Nodes

If you don't have SSH access yet:

1. **Generate SSH key pair (if needed):**
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C "terraform-proxmox"
   ```

2. **Copy public key to yin node:**
   ```bash
   ssh-copy-id root@172.16.0.11
   # Or manually:
   cat ~/.ssh/id_ed25519.pub | ssh root@172.16.0.11 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
   ```

3. **Test SSH access:**
   ```bash
   ssh root@172.16.0.11 "echo 'SSH works'"
   ```

## Terraform Provider Configuration

The provider is configured in `lab-infra/terraform/providers.tf`:

```hcl
ssh {
  agent       = var.use_ssh_agent  # true = use SSH agent, false = use private key file
  username    = "root"
  private_key = var.use_ssh_agent ? null : file("~/.ssh/id_ed25519")
  node {
    name    = "yin" 
    address = "172.16.0.11"
  }
}
```

## Current Status

- ✅ Snippets datastore configured on yin/yang
- ✅ Terraform configured to use "snippets" datastore
- ❌ SSH authentication failing

## Next Steps

1. Set up SSH key access to yin node (172.16.0.11)
2. Ensure SSH agent is running and has the key loaded
3. Test SSH connection manually
4. Retry VM creation

