#!/bin/bash
# Assign AdminPlus role to llm@pve user for Terraform operations

echo "🔧 Assigning AdminPlus role to llm@pve user..."

# Check if user exists
if ! pveum user list | grep -q "llm@pve"; then
  echo "❌ User llm@pve not found"
  exit 1
fi

# Assign AdminPlus role to user on root path (propagates to all resources)
echo "Assigning AdminPlus role on / (root path)..."
pveum aclmod / -user llm@pve -role AdminPlus --propagate 1

if [ $? -eq 0 ]; then
  echo "✅ Successfully assigned AdminPlus role"
else
  echo "❌ Failed to assign AdminPlus role"
  exit 1
fi

echo ""
echo "📋 Verifying permissions..."
pveum user permissions llm@pve

echo ""
echo "💡 Next steps:"
echo "   1. Recreate the token to pick up new permissions:"
echo "      pveum user token delete llm@pve llm-agent"
echo "      pveum user token add llm@pve llm-agent --privsep 0"
echo ""
echo "   2. Update your .env file with the new token secret"
echo ""
echo "   3. Test with: bash scripts/test-terraform-token.sh"

