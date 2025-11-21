# Proxmox Palindrome Agent User Setup

This document provides commands to set up the `palindrome-agent` user and API token on a Proxmox node (version 8.4.1).

## Quick Setup Script

Run the provided script on the Proxmox node:

```bash
# On the Proxmox node (as root or with sudo)
./scripts/setup-proxmox-palindrome-user.sh [NODE_NAME]
```

Replace `[NODE_NAME]` with the actual node name (e.g., `proxBig`, `yin`, `YANG`).

## Manual Setup Commands

If you prefer to run commands manually:

### 1. Create User

```bash
# Create the palindrome-agent user
pveum user add palindrome-agent@pve --password "$(openssl rand -base64 32)" --comment "Palindrome Agent User"
```

### 2. Create API Token

```bash
# Create API token (save the secret that is displayed!)
pveum user token add palindrome-agent@pve pce-token --privsep 0
```

**IMPORTANT**: Save the token secret that is displayed. You'll need it for `PROXMOX_TOKEN_SECRET`.

### 3. Set ACL Permissions

```bash
# Root path - PVEAuditor role
# Note: Use -token (not -user) for API tokens, and single quotes to prevent bash history expansion
pveum aclmod / -token 'palindrome-agent@pve!pce-token' -role PVEAuditor

# Nodes path - PVEVMAdmin role
pveum aclmod /nodes -token 'palindrome-agent@pve!pce-token' -role PVEVMAdmin

# Specific node - PVEVMAdmin and PVEAuditor roles
# Replace NODE_NAME with actual node name (e.g., proxBig, yin, YANG)
pveum aclmod /nodes/NODE_NAME -token 'palindrome-agent@pve!pce-token' -role PVEVMAdmin
pveum aclmod /nodes/NODE_NAME -token 'palindrome-agent@pve!pce-token' -role PVEAuditor

# VMs path - PVEAdmin role
pveum aclmod /vms -token 'palindrome-agent@pve!pce-token' -role PVEAdmin

# Optional: Specific VM permissions (if needed)
# pveum aclmod /vms/VMID -token 'palindrome-agent@pve!pce-token' -role PVEAdmin
```

### 4. Verify Setup

```bash
# List all ACLs to verify
pveum acl list

# List user tokens
pveum user token list palindrome-agent@pve

# View user details
pveum user list
```

## Environment Variables

After setup, configure these environment variables:

```bash
export PROXMOX_URL="https://your-proxmox-node:8006"
export PROXMOX_TOKEN_ID="palindrome-agent@pve!pce-token"
export PROXMOX_TOKEN_SECRET="<token-secret-from-step-2>"
export PROXMOX_VERIFY_SSL="true"  # or "false" for self-signed certs
```

### Node-Specific Token Secrets

If you have multiple Proxmox nodes with different token secrets (but same token ID), you can use node-specific environment variables. The system will automatically detect and use them based on the hostname in `PROXMOX_URL`:

```bash
# Default/fallback token secret
export PROXMOX_TOKEN_SECRET="<default-token-secret>"

# Node-specific token secrets (optional, takes precedence)
export PROXBIG_TOKEN_SECRET="<proxbig-specific-token-secret>"
export YIN_TOKEN_SECRET="<yin-specific-token-secret>"
export YANG_TOKEN_SECRET="<yang-specific-token-secret>"
```

The system extracts the node name from the `PROXMOX_URL` hostname (e.g., `proxbig.example.com` → `PROXBIG_TOKEN_SECRET`) and uses the node-specific secret if available, otherwise falls back to `PROXMOX_TOKEN_SECRET`.

## Role Permissions

- **PVEAuditor**: Read-only access to cluster resources
- **PVEVMAdmin**: Full VM/container management (start, stop, migrate, snapshot, etc.)
- **PVEAdmin**: Full administrative access to VMs

## Troubleshooting

### Permission Denied (403) Errors

If you get 403 errors, verify:
1. The token secret is correct
2. The ACL permissions are set correctly: `pveum acl list`
3. The node name in the ACL matches exactly (case-sensitive)

### Token Not Found

If the token doesn't exist:
```bash
# List all tokens for the user
pveum user token list palindrome-agent@pve

# If token doesn't exist, create it again
pveum user token add palindrome-agent@pve pce-token --privsep 0
```

### Node Name Case Sensitivity

Proxmox node names are case-sensitive. If you get 403 errors, check the exact case:
```bash
# List all nodes to see exact names
pveum node list
# or
pvesh get /nodes
```

## Example: Setting up proxBig Node

```bash
# 1. Create user
pveum user add palindrome-agent@pve --password "$(openssl rand -base64 32)" --comment "Palindrome Agent User"

# 2. Create token (save the secret!)
pveum user token add palindrome-agent@pve pce-token --privsep 0

# 3. Set permissions (use -token for API tokens, single quotes to prevent bash history expansion)
pveum aclmod / -token 'palindrome-agent@pve!pce-token' -role PVEAuditor
pveum aclmod /nodes -token 'palindrome-agent@pve!pce-token' -role PVEVMAdmin
pveum aclmod /nodes/proxBig -token 'palindrome-agent@pve!pce-token' -role PVEVMAdmin
pveum aclmod /nodes/proxBig -token 'palindrome-agent@pve!pce-token' -role PVEAuditor
pveum aclmod /vms -token 'palindrome-agent@pve!pce-token' -role PVEAdmin

# 4. Verify
pveum acl list | grep palindrome-agent
```

