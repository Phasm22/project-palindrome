#!/bin/bash
# Setup palindrome-agent user and permissions for Proxmox 8.4.1
# Run this script on the Proxmox node as root or with sudo

set -e

echo "Setting up palindrome-agent user and permissions..."

# 1. Create the user (if it doesn't exist)
echo "Creating user palindrome-agent@pve..."
pveum user add palindrome-agent@pve --password "$(openssl rand -base64 32)" --comment "Palindrome Agent User" || echo "User may already exist"

# 2. Create API token for palindrome-agent
echo "Creating API token palindrome-agent@pve!pce-token..."
# Note: Token secret will be displayed - save it securely!
pveum user token add palindrome-agent@pve pce-token --privsep 0 || echo "Token may already exist"

# 3. Set ACL permissions
echo "Setting up ACL permissions..."

# Root path with PVEAuditor role
echo "  - Setting PVEAuditor on /"
pveum aclmod / -token 'palindrome-agent@pve!pce-token' -role PVEAuditor

# Nodes path with PVEVMAdmin role
echo "  - Setting PVEVMAdmin on /nodes"
pveum aclmod /nodes -token 'palindrome-agent@pve!pce-token' -role PVEVMAdmin

# Specific node permissions (replace NODE_NAME with actual node name, e.g., proxBig)
NODE_NAME="${1:-proxBig}"  # Accept node name as first argument, default to proxBig
echo "  - Setting permissions for node: $NODE_NAME"

# PVEVMAdmin on specific node
pveum aclmod /nodes/$NODE_NAME -token 'palindrome-agent@pve!pce-token' -role PVEVMAdmin

# PVEAuditor on specific node
pveum aclmod /nodes/$NODE_NAME -token 'palindrome-agent@pve!pce-token' -role PVEAuditor

# VMs path with PVEAdmin role
echo "  - Setting PVEAdmin on /vms"
pveum aclmod /vms -token 'palindrome-agent@pve!pce-token' -role PVEAdmin

# Optional: Specific VM permissions (uncomment and modify as needed)
# echo "  - Setting PVEAdmin on /vms/105"
# pveum aclmod /vms/105 -token 'palindrome-agent@pve!pce-token' -role PVEAdmin

echo ""
echo "Setup complete!"
echo ""
echo "IMPORTANT: Save the API token secret shown above!"
echo "The token ID is: palindrome-agent@pve!pce-token"
echo ""
echo "To view the token secret again (if you missed it), run:"
echo "  pveum user token list palindrome-agent@pve"
echo ""
echo "To verify permissions, run:"
echo "  pveum acl list"

