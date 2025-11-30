#!/bin/bash
# Test Terraform token permissions

# Load .env file if it exists
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

if [ -f "$ENV_FILE" ]; then
  echo "📁 Loading environment from .env file..."
  # Export variables from .env (handle comments and empty lines)
  set -a
  source "$ENV_FILE"
  set +a
fi

TOKEN_ID="${CLUSTER_TF_TOKEN_ID:-$PROXBIG_TF_TOKEN_ID}"
TOKEN_SECRET="${PROXMOX_CLUSTER_TF_SECRET:-$PROXMOX_PROXBIG_TF_SECRET}"
PROXMOX_URL="${PROXMOX_URL}"

if [ -z "$TOKEN_ID" ] || [ -z "$TOKEN_SECRET" ]; then
  echo "❌ Missing token environment variables"
  echo "   Expected: CLUSTER_TF_TOKEN_ID or PROXBIG_TF_TOKEN_ID"
  echo "   Expected: PROXMOX_CLUSTER_TF_SECRET or PROXMOX_PROXBIG_TF_SECRET"
  echo "   Check your .env file at: $ENV_FILE"
  exit 1
fi

# Clean URL
CLEAN_URL="${PROXMOX_URL%/api2/json}"
CLEAN_URL="${CLEAN_URL%/}"

echo "🔍 Testing Terraform token permissions..."
echo "Token ID: $TOKEN_ID"
echo "Proxmox URL: $CLEAN_URL"
echo ""

# Test 1: List nodes (basic read)
echo "1. Testing node list (read permission)..."
curl -k -H "Authorization: PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}" \
  "${CLEAN_URL}/api2/json/nodes" 2>/dev/null | jq -r '.data[]?.node // "FAILED"' || echo "❌ Failed to list nodes"

echo ""

# Test 2: List datastores
echo "2. Testing datastore list (read permission)..."
curl -k -H "Authorization: PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}" \
  "${CLEAN_URL}/api2/json/nodes/YANG/storage" 2>/dev/null | jq -r '.data[]?.storage // "FAILED"' || echo "❌ Failed to list datastores"

echo ""

# Test 3: List files in snippets datastore (this is what's failing)
echo "3. Testing snippets datastore access (write permission needed)..."

# First, get the actual node name from the API (case-sensitive)
NODE_LIST=$(curl -k -s -H "Authorization: PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}" \
  "${CLEAN_URL}/api2/json/nodes" 2>/dev/null)

if [ $? -eq 0 ] && [ -n "$NODE_LIST" ]; then
  # Try to find YANG node (case-insensitive match)
  NODE_NAME=$(echo "$NODE_LIST" | jq -r '.data[]?.node | select(. | test("^[Yy][Aa][Nn][Gg]$"))' 2>/dev/null | head -1)
  if [ -z "$NODE_NAME" ]; then
    # Fallback: use first node or YANG
    NODE_NAME=$(echo "$NODE_LIST" | jq -r '.data[0].node // "YANG"' 2>/dev/null)
  fi
  if [ -n "$NODE_NAME" ] && [ "$NODE_NAME" != "null" ]; then
    echo "   Using node: $NODE_NAME"
  else
    NODE_NAME="YANG"
    echo "   Warning: Could not parse node list, using default: $NODE_NAME"
  fi
else
  NODE_NAME="YANG"
  echo "   Warning: Could not fetch node list, using default: $NODE_NAME"
fi

# Test the snippets endpoint
RESPONSE=$(curl -k -s -w "\n%{http_code}" -H "Authorization: PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}" \
  "${CLEAN_URL}/api2/json/nodes/${NODE_NAME}/storage/snippets/content" 2>/dev/null)

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Can read snippets datastore"
  echo "$BODY" | jq -r '.data[0:3] | .[]?.volid // "No files found"' 2>/dev/null || echo "No files"
else
  echo "❌ Cannot access snippets datastore (HTTP $HTTP_CODE)"
  ERROR_MSG=$(echo "$BODY" | jq -r '.message // .data.message // .data // .' 2>/dev/null || echo "$BODY")
  echo "   Error: $ERROR_MSG"
  
  # Additional debugging
  echo ""
  echo "🔍 Debug info:"
  echo "   URL tested: ${CLEAN_URL}/api2/json/nodes/${NODE_NAME}/storage/snippets/content"
  echo "   Token ID: ${TOKEN_ID}"
  echo "   Token secret length: ${#TOKEN_SECRET} characters"
  
  # Test alternative endpoint
  echo ""
  echo "   Testing alternative endpoint: /storage/snippets/content"
  ALT_RESPONSE=$(curl -k -s -w "\n%{http_code}" -H "Authorization: PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}" \
    "${CLEAN_URL}/api2/json/storage/snippets/content" 2>/dev/null)
  ALT_HTTP_CODE=$(echo "$ALT_RESPONSE" | tail -n1)
  if [ "$ALT_HTTP_CODE" = "200" ]; then
    echo "   ✅ Alternative endpoint works! (but node-specific endpoint doesn't)"
  else
    echo "   ❌ Alternative endpoint also failed (HTTP $ALT_HTTP_CODE)"
  fi
  
  if [ "$HTTP_CODE" = "401" ]; then
    echo ""
    echo "🔍 Troubleshooting 401 error:"
    echo "   1. Check user permissions and assigned role:"
    echo "      pveum user permissions llm@pve"
    echo ""
    echo "   2. Check if AdminPlus role has datastore permissions:"
    echo "      pveum role show AdminPlus | grep -i datastore"
    echo ""
    echo "   3. If user has PVEVMAdmin, switch to AdminPlus:"
    echo "      pveum aclmod / -user llm@pve -role AdminPlus --propagate 1"
    echo ""
    echo "   3. If permissions were just added, you may need to:"
    echo "      - Wait a few seconds for propagation"
    echo "      - Or recreate the token: pveum user token delete llm@pve llm-agent && pveum user token add llm@pve llm-agent"
    echo ""
    echo "   4. Verify token format is correct:"
    echo "      Token ID should be: llm@pve!llm-agent"
    echo "      Token secret should match what's in .env"
  fi
fi

echo ""
echo "💡 If test 3 fails with 401, the token needs Datastore.AllocateTemplate permission"
echo "   Run: pveum role modify PVEVMAdmin -privs \"[existing privs],Datastore.AllocateTemplate,Datastore.AllocateSpace\""

