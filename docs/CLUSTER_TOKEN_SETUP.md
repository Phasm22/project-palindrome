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
PROXMOX_CLUSTER_TF_SECRET=<secret-from-yang-or-yin>

# proxBig standalone token pair
PROXBIG_TF_TOKEN_ID=llm@pve!llm-agent
PROXBIG_TF_SECRET=<secret-from-proxBig>

# Optional: Node-specific secrets (if different)
PROXMOX_YIN_TF_SECRET=<secret-from-yin>
PROXMOX_YANG_TF_SECRET=<secret-from-yang>

# Node URLs
PROXMOX_URL=https://proxBig.prox:8006/api2/json
PROXMOX_YIN_URL=https://yin.prox:8006/api2/json
PROXMOX_YANG_URL=https://YANG.prox:8006/api2/json
```

### 3. How It Works

The resolver selects deterministic `TOKEN_ID + TOKEN_SECRET` pairs based on endpoint URL:

- **proxBig**: Uses `PROXBIG_TF_TOKEN_ID + PROXBIG_TF_SECRET` (or another complete proxBig pair)
- **yin**: Uses `CLUSTER_TF_TOKEN_ID + PROXMOX_YIN_TF_SECRET` (or `PROXMOX_CLUSTER_TF_SECRET`)
- **yang**: Uses `CLUSTER_TF_TOKEN_ID + PROXMOX_YANG_TF_SECRET` (or `PROXMOX_CLUSTER_TF_SECRET`)

It does not mix unrelated token IDs and secrets.

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
   - `Only proxBig endpoint is configured...` (cluster credentials missing)
3. **Check `/health`** – response includes `proxmoxEndpoints: { count, labels }` (no secrets). If `count === 1` and `labels === ['proxbig']`, cluster env is not set for this process.
4. **Ensure complete pairs** – for cluster (yin/YANG) set a complete pair like `CLUSTER_TF_TOKEN_ID + PROXMOX_CLUSTER_TF_SECRET` (or node-specific `PROXMOX_YIN_TF_SECRET` / `PROXMOX_YANG_TF_SECRET`). For proxBig set a complete pair like `PROXBIG_TF_TOKEN_ID + PROXBIG_TF_SECRET`.

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
