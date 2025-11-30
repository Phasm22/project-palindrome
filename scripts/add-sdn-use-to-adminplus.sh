#!/bin/bash
# Add SDN.Use permission to AdminPlus role
# This is needed for VM network operations even when using regular Linux bridges

set -e

echo "🔧 Adding SDN.Use permission to AdminPlus role..."

# Get current AdminPlus privileges
CURRENT_PRIVS=$(pveum role show AdminPlus 2>/dev/null | grep -E "^Privs:" | cut -d: -f2 | xargs)

if [ -z "$CURRENT_PRIVS" ]; then
    echo "❌ Could not read AdminPlus role privileges"
    exit 1
fi

# Check if SDN.Use is already present
if echo "$CURRENT_PRIVS" | grep -q "SDN.Use"; then
    echo "✅ SDN.Use is already in AdminPlus role"
    echo "Current privileges: $CURRENT_PRIVS"
    exit 0
fi

# Add SDN.Use to the privileges
NEW_PRIVS="$CURRENT_PRIVS,SDN.Use"

echo "Current privileges: $CURRENT_PRIVS"
echo "Adding SDN.Use..."
pveum role modify AdminPlus -privs "$NEW_PRIVS"

echo "✅ Updated AdminPlus role with SDN.Use permission"
echo ""
echo "📋 Updated privileges:"
pveum role show AdminPlus | grep -E "^Privs:"

echo ""
echo "⚠️  IMPORTANT: You must recreate the API token for changes to take effect:"
echo "   pveum user token delete llm@pve llm-agent"
echo "   pveum user token add llm@pve llm-agent --privsep 0"
echo "   Then update PROXMOX_YIN_TF_SECRET in .env with the new token secret"

