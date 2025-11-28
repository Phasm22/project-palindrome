#!/bin/bash
# Setup tokens for cluster nodes (yin and yang)
# Run this on each cluster node

echo "🔧 Setting up Terraform tokens for cluster nodes"
echo ""
echo "This script helps you create tokens on yin and yang nodes."
echo "You'll need to run the token creation commands on each node."
echo ""

# Load .env to see current config
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

echo "Current configuration:"
echo "  CLUSTER_TF_TOKEN_ID: ${CLUSTER_TF_TOKEN_ID:-not set}"
echo "  PROXMOX_CLUSTER_TF_SECRET: ${PROXMOX_CLUSTER_TF_SECRET:0:8}... (from proxBig)"
echo ""

echo "📋 Instructions for cluster nodes:"
echo ""
echo "1. On YIN node, run:"
echo "   pveum user token delete llm@pve llm-agent"
echo "   pveum user token add llm@pve llm-agent --privsep 0"
echo "   (Save the secret that's displayed)"
echo ""
echo "2. On YANG node, run:"
echo "   pveum user token delete llm@pve llm-agent"
echo "   pveum user token add llm@pve llm-agent --privsep 0"
echo "   (Save the secret that's displayed)"
echo ""
echo "3. Update your .env file with:"
echo "   PROXMOX_YIN_TF_SECRET=<secret from yin>"
echo "   PROXMOX_YANG_TF_SECRET=<secret from yang>"
echo ""
echo "💡 Note: In a Proxmox cluster, you can use the same token ID but each node"
echo "   generates its own secret. Terraform will use the appropriate secret"
echo "   based on which node you're targeting."
echo ""
echo "Alternatively, if you want to use a single cluster endpoint, you can:"
echo "  - Point PROXMOX_URL to one of the cluster nodes (yin or yang)"
echo "  - Use that node's token secret for PROXMOX_CLUSTER_TF_SECRET"
echo "  - Terraform will be able to manage VMs on any node in the cluster"

