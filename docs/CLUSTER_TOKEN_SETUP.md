# Cluster Token Setup Guide

## Overview

Palindrome supports both standalone nodes (proxBig) and cluster nodes (yin, yang). Since Proxmox tokens are per-node, you need to set up tokens for each node you want to manage.

## Current Setup

- **proxBig**: Standalone node ✅ (token configured)
- **yin**: Cluster node (needs token)
- **yang**: Cluster node (needs token)

## Setup Instructions

### 1. Create Tokens on Cluster Nodes

**On YIN node:**
```bash
pveum user token delete llm@pve llm-agent
pveum user token add llm@pve llm-agent --privsep 0
# Save the secret that's displayed
```

**On YANG node:**
```bash
pveum user token delete llm@pve llm-agent
pveum user token add llm@pve llm-agent --privsep 0
# Save the secret that's displayed
```

### 2. Update .env File

Add the cluster node tokens to your `.env` file:

```bash
# Cluster tokens (for yin and yang)
CLUSTER_TF_TOKEN_ID=llm@pve!llm-agent
PROXMOX_CLUSTER_TF_SECRET=<secret-from-proxBig>  # For proxBig operations

# Optional: Node-specific secrets (if different)
PROXMOX_YIN_TF_SECRET=<secret-from-yin>
PROXMOX_YANG_TF_SECRET=<secret-from-yang>

# Node URLs
PROXMOX_URL=https://proxBig.prox:8006/api2/json
PROXMOX_YIN_URL=https://yin.prox:8006/api2/json
PROXMOX_YANG_URL=https://YANG.prox:8006/api2/json
```

### 3. How It Works

The `TerraformRunner` automatically selects the correct token based on the target node:

- **proxBig**: Uses `PROXMOX_URL` + `PROXMOX_CLUSTER_TF_SECRET`
- **yin**: Uses `PROXMOX_YIN_URL` (or `PROXMOX_URL`) + `PROXMOX_YIN_TF_SECRET` (or `PROXMOX_CLUSTER_TF_SECRET`)
- **yang**: Uses `PROXMOX_YANG_URL` (or `PROXMOX_URL`) + `PROXMOX_YANG_TF_SECRET` (or `PROXMOX_CLUSTER_TF_SECRET`)

### 4. Testing

Test token access for each node:

```bash
# Test proxBig (already working)
bash scripts/test-terraform-token.sh

# Test yin (after setting up token)
PROXMOX_URL=https://yin.prox:8006/api2/json PROXMOX_CLUSTER_TF_SECRET=<yin-secret> bash scripts/test-terraform-token.sh

# Test yang (after setting up token)
PROXMOX_URL=https://YANG.prox:8006/api2/json PROXMOX_CLUSTER_TF_SECRET=<yang-secret> bash scripts/test-terraform-token.sh
```

## Troubleshooting: API process

The PCE API (`bun run pce:api`) loads `.env` at startup and uses `getProxmoxEndpointConfigs()` for list_nodes, ingestion, and create_vm. If only proxBig appears (yin/YANG missing):

1. **Restart the API** after changing `.env` (env is read at process start).
2. **Check startup logs** – you should see either:
   - `Proxmox endpoints configured { count: 2, labels: ['cluster', 'proxbig'] }` (cluster + proxbig), or
   - `Only proxBig endpoint is configured. To see cluster nodes (yin/YANG), set PROXMOX_URL, PROXMOX_TOKEN_ID, PROXMOX_TOKEN_SECRET (or CLUSTER_TF_*) in .env and restart.`
3. **Check `/health`** – response includes `proxmoxEndpoints: { count, labels }` (no secrets). If `count === 1` and `labels === ['proxbig']`, cluster env is not set for this process.
4. **Ensure cluster vars** – for cluster (yin/YANG) the API needs at least: `PROXMOX_URL` (or `PROXMOX_YIN_URL`), `PROXMOX_TOKEN_ID` (or `CLUSTER_TF_TOKEN_ID`), and `PROXMOX_TOKEN_SECRET` (or `PROXMOX_CLUSTER_TF_SECRET`). Same `.env` used by `bun run pce:api` must contain these.

## Notes

- **Token ID is the same**: `llm@pve!llm-agent` works on all nodes
- **Token secrets are different**: Each node generates its own secret
- **Permissions**: Make sure `llm@pve` user has `AdminPlus` role (or equivalent) on all nodes
- **Cluster vs Standalone**: yin and yang are in a cluster, proxBig is standalone

## Quick Setup Script

Run on each cluster node:

```bash
# On yin
pveum aclmod / -user llm@pve -role AdminPlus --propagate 1
pveum user token delete llm@pve llm-agent
pveum user token add llm@pve llm-agent --privsep 0

# On yang  
pveum aclmod / -user llm@pve -role AdminPlus --propagate 1
pveum user token delete llm@pve llm-agent
pveum user token add llm@pve llm-agent --privsep 0
```

Then update `.env` with the secrets.

