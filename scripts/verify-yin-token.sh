#!/bin/bash
# Verify and recreate yin token if needed

set -e

echo "🔍 Verifying yin token..."

# Load .env from project root (script may be run from scripts/ directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

if [ -f "$ENV_FILE" ]; then
    source "$ENV_FILE"
    echo "✅ Loaded .env from: $ENV_FILE"
else
    echo "⚠️  .env file not found at: $ENV_FILE"
    echo "   Trying current directory..."
    if [ -f .env ]; then
        source .env
        echo "✅ Loaded .env from current directory"
    fi
fi

TOKEN_ID="${CLUSTER_TF_TOKEN_ID:-llm@pve!llm-agent}"
SECRET="${PROXMOX_YIN_TF_SECRET}"

if [ -z "$SECRET" ]; then
    echo "❌ PROXMOX_YIN_TF_SECRET not set in .env"
    exit 1
fi

echo "Testing token: ${TOKEN_ID}=${SECRET:0:8}..."
echo ""

# Test token
RESPONSE=$(curl -k -s -w "\n%{http_code}" -H "Authorization: PVEAPIToken=${TOKEN_ID}=${SECRET}" "https://172.16.0.11:8006/api2/json/version" 2>&1)
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ]; then
    echo "✅ Token is valid!"
    echo "Response: $BODY"
else
    echo "❌ Token test failed (HTTP $HTTP_CODE)"
    echo "Response: $BODY"
    echo ""
    echo "💡 The token secret in .env may be outdated."
    echo "   Recreate the token on yin:"
    echo "   ssh root@172.16.0.11"
    echo "   pveum user token delete llm@pve llm-agent"
    echo "   pveum user token add llm@pve llm-agent --privsep 0"
    echo "   Then update PROXMOX_YIN_TF_SECRET in .env with the new secret"
fi

