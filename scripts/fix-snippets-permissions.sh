#!/bin/bash
# Fix permissions for /var/lib/vz/snippets so opsadmin can write cloud-init snippets
# This is required for Terraform's proxmox_virtual_environment_file resource

set -e

NODES=("yin" "yang" "proxBig")
NODE_IPS=("172.16.0.11" "172.16.0.12" "172.16.0.10")

echo "🔧 Fixing /var/lib/vz/snippets permissions for opsadmin on all nodes..."

for i in "${!NODES[@]}"; do
    NODE="${NODES[$i]}"
    IP="${NODE_IPS[$i]}"
    
    echo ""
    echo "📦 Processing node: $NODE ($IP)"
    
    # Check if opsadmin can SSH
    if ssh -o ConnectTimeout=5 -o BatchMode=yes opsadmin@$IP "echo 'SSH OK'" 2>/dev/null; then
        echo "✅ SSH connection to $NODE successful"
        
        # Check current permissions
        CURRENT_PERMS=$(ssh opsadmin@$IP "ls -ld /var/lib/vz/snippets 2>/dev/null | awk '{print \$1, \$3, \$4}'" 2>/dev/null || echo "NOT FOUND")
        echo "   Current permissions: $CURRENT_PERMS"
        
        # Try to fix permissions (requires root access)
        echo "   Attempting to fix permissions..."
        
        # Option 1: Add opsadmin to a group that owns the directory
        # Option 2: Set ACLs to allow opsadmin write access
        # Option 3: Change group ownership to a group opsadmin is in
        
        # Check if opsadmin is in any groups that might have access
        OPSADMIN_GROUPS=$(ssh opsadmin@$IP "groups" 2>/dev/null || echo "")
        echo "   opsadmin groups: $OPSADMIN_GROUPS"
        
        # We need root access to fix this
        echo "   ⚠️  This requires root access. Options:"
        echo "      1. Add opsadmin to a group with write access (e.g., 'pve' or 'www-data')"
        echo "      2. Set ACL: setfacl -m u:opsadmin:rwx /var/lib/vz/snippets"
        echo "      3. Change group: chgrp <group> /var/lib/vz/snippets && chmod g+w /var/lib/vz/snippets"
        echo ""
        echo "   Run this on $NODE as root:"
        echo "     setfacl -m u:opsadmin:rwx /var/lib/vz/snippets"
        echo "     # OR"
        echo "     chgrp pve /var/lib/vz/snippets && chmod g+w /var/lib/vz/snippets"
        echo "     usermod -a -G pve opsadmin  # if opsadmin not in pve group"
        
    else
        echo "❌ Cannot SSH to $NODE as opsadmin"
    fi
done

echo ""
echo "✅ Permission fix instructions displayed above"
echo "💡 After fixing permissions, verify with:"
echo "   ssh opsadmin@<node> 'test -w /var/lib/vz/snippets && echo WRITABLE || echo NOT WRITABLE'"

