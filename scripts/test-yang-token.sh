#!/bin/bash
# Test yang node token

# Load .env file
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

TOKEN_ID="${CLUSTER_TF_TOKEN_ID}"
TOKEN_SECRET="${PROXMOX_YANG_TF_SECRET}"
YANG_URL="${PROXMOX_YANG_URL:-https://yang.prox:8006}"

if [ -z "$TOKEN_ID" ] || [ -z "$TOKEN_SECRET" ]; then
  echo "❌ Missing token for yang node"
  echo "   TOKEN_ID: ${TOKEN_ID:-not set}"
  echo "   TOKEN_SECRET: ${TOKEN_SECRET:+set (${#TOKEN_SECRET} chars)}${TOKEN_SECRET:-not set}"
  exit 1
fi

# Clean URL
CLEAN_URL="${YANG_URL%/api2/json}"
CLEAN_URL="${CLEAN_URL%/}"

echo "🔍 Testing yang node token..."
echo "Token ID: $TOKEN_ID"
echo "Token Secret: ${TOKEN_SECRET:0:8}...${TOKEN_SECRET: -4} (${#TOKEN_SECRET} chars)"
echo "Yang URL: $CLEAN_URL"
echo ""

# Test authentication
echo "1. Testing authentication..."
RESPONSE=$(curl -k -s -w "\n%{http_code}" \
  -H "Authorization: PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}" \
  "${CLEAN_URL}/api2/json/version")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Authentication successful!"
  VERSION=$(echo "$BODY" | jq -r '.data.version // .version // "unknown"' 2>/dev/null)
  echo "   Proxmox version: $VERSION"
else
  echo "❌ Authentication failed (HTTP $HTTP_CODE)"
  ERROR_MSG=$(echo "$BODY" | jq -r '.message // .data.message // .' 2>/dev/null || echo "$BODY")
  echo "   Error: $ERROR_MSG"
  exit 1
fi

# Test local datastore (yang uses "local" not "snippets")
# Note: Node name must be uppercase "YANG" (case-sensitive)
echo ""
echo "2. Testing local datastore access..."
RESPONSE=$(curl -k -s -w "\n%{http_code}" \
  -H "Authorization: PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}" \
  "${CLEAN_URL}/api2/json/nodes/YANG/storage/local/content")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Can access local datastore"
  FILE_COUNT=$(echo "$BODY" | jq -r '.data | length' 2>/dev/null || echo "0")
  echo "   Files found: $FILE_COUNT"
else
  echo "❌ Cannot access local datastore (HTTP $HTTP_CODE)"
  ERROR_MSG=$(echo "$BODY" | jq -r '.message // .data.message // .' 2>/dev/null || echo "$BODY")
  echo "   Error: $ERROR_MSG"
  echo ""
  echo "💡 Troubleshooting:"
  echo "   1. Verify token was created on yang node:"
  echo "      ssh yang 'pveum user token list llm@pve'"
  echo ""
  echo "   2. Check token secret matches .env:"
  echo "      grep PROXMOX_YANG_TF_SECRET .env"
  echo ""
  echo "   3. Verify token has AdminPlus role:"
  echo "      ssh yang 'pveum user permissions llm@pve | grep -i datastore'"
  exit 1
fi

echo ""
echo "✅ All tests passed! Token is ready for Terraform on yang node."
