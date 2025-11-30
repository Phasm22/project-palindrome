#!/bin/bash
# Add datastore permissions to PVEVMAdmin role for Terraform/cloud-init support

echo "🔧 Adding datastore permissions to PVEVMAdmin role..."

# Get current PVEVMAdmin privileges
CURRENT_PRIVS=$(pveum role show PVEVMAdmin | grep -oP 'Privs: \K.*' || echo "")

if [ -z "$CURRENT_PRIVS" ]; then
  echo "❌ Could not read current PVEVMAdmin privileges"
  exit 1
fi

echo "Current privileges: $CURRENT_PRIVS"
echo ""

# Check if datastore permissions already exist
if echo "$CURRENT_PRIVS" | grep -q "Datastore.AllocateTemplate"; then
  echo "✅ Datastore.AllocateTemplate already exists in PVEVMAdmin"
else
  echo "➕ Adding Datastore.AllocateTemplate..."
  NEW_PRIVS="${CURRENT_PRIVS},Datastore.AllocateTemplate"
fi

if echo "$CURRENT_PRIVS" | grep -q "Datastore.AllocateSpace"; then
  echo "✅ Datastore.AllocateSpace already exists in PVEVMAdmin"
else
  echo "➕ Adding Datastore.AllocateSpace..."
  if [ -z "$NEW_PRIVS" ]; then
    NEW_PRIVS="${CURRENT_PRIVS},Datastore.AllocateSpace"
  else
    NEW_PRIVS="${NEW_PRIVS},Datastore.AllocateSpace"
  fi
fi

if [ -n "$NEW_PRIVS" ]; then
  echo ""
  echo "Updating PVEVMAdmin role with new privileges..."
  pveum role modify PVEVMAdmin -privs "$NEW_PRIVS"
  
  if [ $? -eq 0 ]; then
    echo "✅ Successfully updated PVEVMAdmin role"
    echo ""
    echo "New privileges:"
    pveum role show PVEVMAdmin | grep Privs
  else
    echo "❌ Failed to update PVEVMAdmin role"
    exit 1
  fi
else
  echo "✅ All required datastore permissions already exist"
fi

echo ""
echo "💡 Note: If you're using a token, you may need to:"
echo "   1. Wait a few seconds for permissions to propagate"
echo "   2. Or recreate the token to pick up new permissions"
echo ""
echo "To verify token permissions:"
echo "  pveum user permissions llm@pve"

