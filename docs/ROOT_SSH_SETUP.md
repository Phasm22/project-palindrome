# Root SSH Setup for Terraform

## Problem

The `proxmox_virtual_environment_file` resource requires SSH access to upload cloud-init snippets to `/var/lib/vz/snippets/`. This directory is owned by `root:root` with `755` permissions, meaning **only root can write to it**.

## Solution

Terraform must SSH as `root`, not as a regular user like `opsadmin`.

## Setup Steps

### 1. Ensure Root Has Passwordless SSH Access

You need to add your SSH public key to root's `authorized_keys` on each Proxmox node:

```bash
# On your local machine, copy your public key
cat ~/.ssh/id_ed25519.pub

# On each Proxmox node (yin, yang, proxBig), as root:
mkdir -p /root/.ssh
chmod 700 /root/.ssh
echo "YOUR_PUBLIC_KEY_HERE" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
```

### 2. Verify Root SSH Access

```bash
# Test passwordless SSH to root
ssh root@172.16.0.11 "whoami"  # Should return: root
ssh root@172.16.0.12 "whoami"  # Should return: root
ssh root@172.16.0.10 "whoami"  # Should return: root
```

### 3. Ensure SSH Agent Has Root's Key

The Terraform provider uses the SSH agent. Make sure your SSH key is loaded:

```bash
# Check if key is loaded
ssh-add -l

# If not, add it
ssh-add ~/.ssh/id_ed25519
```

### 4. Provider Configuration

The provider is already configured to use `root`:

```hcl
provider "proxmox" {
  endpoint  = var.proxmox_api_url
  api_token = var.proxmox_token_secret
  insecure  = true

  ssh {
    agent    = true
    username = "root"  # Must be root for snippet uploads
    node {
      name    = "proxBig"
      address = "172.16.0.10"
    }
    node {
      name    = "yin"
      address = "172.16.0.11"
    }
    node {
      name    = "yang"
      address = "172.16.0.12"
    }
  }
}
```

### 5. Verify Terraform Can SSH as Root

After setup, Terraform logs should show:
```
using ssh user 'root'
```

## Why Root is Required

- `/var/lib/vz/snippets/` is `root:root` with `755` permissions
- Proxmox has no `pve` group or ACL mechanisms for this path
- Proxmox GUI only allows root uploads
- Terraform does not use `sudo` - it must SSH directly as root

## Security Notes

- Root SSH access is required for snippet uploads only
- API token authentication is still used for all other operations
- Consider restricting root SSH access to specific IPs in `/etc/ssh/sshd_config`:
  ```
  Match Address 172.16.0.0/16
      PermitRootLogin yes
  ```

