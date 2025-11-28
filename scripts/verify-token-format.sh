#!/bin/bash
# Verify token format and test authentication

# Load .env file
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

TOKEN_ID="${CLUSTER_TF_TOKEN_ID:-$PROXBIG_TF_TOKEN_ID}"
TOKEN_SECRET="${PROXMOX_CLUSTER_TF_SECRET:-$PROXMOX_PROXBIG_TF_SECRET}"
PROXMOX_URL="${PROXMOX_URL}"

if [ -z "$TOKEN_ID" ] || [ -z "$TOKEN_SECRET" ]; then
  echo "❌ Missing token in .env"
  exit 1
fi

# Clean URL
CLEAN_URL="${PROXMOX_URL%/api2/json}"
CLEAN_URL="${CLEAN_URL%/}"

echo "🔍 Verifying token format..."
echo "Token ID: $TOKEN_ID"
echo "Token Secret: ${TOKEN_SECRET:0:8}...${TOKEN_SECRET: -4} (${#TOKEN_SECRET} chars)"
echo "Expected format: llm@pve!llm-agent=secret-uuid"
echo ""

# Test basic authentication
echo "Testing authentication..."
RESPONSE=$(curl -k -s -w "\n%{http_code}" \
  -H "Authorization: PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}" \
  "${CLEAN_URL}/api2/json/version")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
  echo "✅ Authentication successful!"
  VERSION=$(echo "$BODY" | jq -r '.data.version // .version // "unknown"' 2>/dev/null)
  echo "   Proxmox version: $VERSION"
  
  # Test nodes
  echo ""
  echo "Testing node access..."
  NODES=$(curl -k -s -H "Authorization: PVEAPIToken=${TOKEN_ID}=${TOKEN_SECRET}" \
    "${CLEAN_URL}/api2/json/nodes" 2>/dev/null)
  
  if [ $? -eq 0 ]; then
    NODE_COUNT=$(echo "$NODES" | jq -r '.data | length' 2>/dev/null)
    echo "✅ Can list nodes ($NODE_COUNT nodes found)"
    echo "$NODES" | jq -r '.data[]?.node' 2>/dev/null
  else
    echo "❌ Cannot list nodes"
  fi
else
  echo "❌ Authentication failed (HTTP $HTTP_CODE)"
  ERROR_MSG=$(echo "$BODY" | jq -r '.message // .data.message // .' 2>/dev/null || echo "$BODY")
  echo "   Error: $ERROR_MSG"
  echo ""
  echo "💡 Check:"
  echo "   1. Token secret in .env matches the one from 'pveum user token add'"
  echo "   2. Token ID format: llm@pve!llm-agent"
  echo "   3. No extra spaces or quotes in .env file"
  echo ""
  echo "⚠️  IMPORTANT: In a Proxmox cluster, tokens are per-node!"
  echo "   You recreated the token on 'yin', but you're testing against 'proxBig'"
  echo "   You need to recreate the token on proxBig and use that secret:"
  echo ""
  echo "   On proxBig node:"
  echo "     pveum user token delete llm@pve llm-agent"
  echo "     pveum user token add llm@pve llm-agent --privsep 0"
  echo "   Then update PROXMOX_CLUSTER_TF_SECRET in .env with the new secret"
  exit 1
fi

