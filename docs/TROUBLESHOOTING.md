# Troubleshooting Guide

## Proxmox API Token Expiration

### Problem
API tokens keep expiring, requiring frequent regeneration.

### Root Causes

1. **Token Expiration Date Set**: When creating Proxmox API tokens, you can set an expiration date. If a date is set, the token will stop working after that date.

2. **Token Revocation**: Tokens can be manually revoked in Proxmox UI (Datacenter → Permissions → API Tokens).

3. **Token Permissions Changed**: If token permissions are modified, the token may stop working for certain operations.

### Solutions

#### 1. Create Tokens Without Expiration

When creating API tokens in Proxmox:
- Go to: **Datacenter → Permissions → API Tokens**
- Click **Add** to create a new token
- **Leave "Expire" field EMPTY** (or set to a far future date)
- This creates a token that never expires

#### 2. Check Token Expiration

To check if your token has an expiration:
1. Go to **Datacenter → Permissions → API Tokens**
2. Find your token (e.g., `terraform@pve!terraform-token`)
3. Check the "Expire" column
4. If it shows a date, the token will expire on that date

#### 3. Verify Token Permissions

Ensure your token has the required permissions:
- **For Terraform/VM creation**: `Datastore.Allocate`, `VM.Allocate`, `VM.Clone`, `VM.Config.Disk`, `VM.Config.Network`
- **For VM operations**: `VM.PowerMgmt`, `VM.Monitor`
- **For node operations**: `Sys.Modify`, `Sys.Audit`

#### 4. Environment Variables

Make sure your environment variables are set correctly:
```bash
# For proxBig node
PROXMOX_URL=https://proxBig.prox:8006/api2/json
PROXBIG_TF_TOKEN_ID=terraform@pve!terraform-token
PROXBIG_TF_SECRET=your-token-secret

# For yin/yang cluster
PROXMOX_YIN_URL=https://yin.prox:8006/api2/json
PROXMOX_YANG_URL=https://yang.prox:8006/api2/json
CLUSTER_TF_TOKEN_ID=terraform@pve!cluster-token
PROXMOX_YIN_TF_SECRET=your-yin-secret
PROXMOX_YANG_TF_SECRET=your-yang-secret
```

### Prevention

1. **Use Long-Lived Tokens**: Create tokens without expiration for automation
2. **Document Token Creation**: Keep a record of when tokens were created and their purpose
3. **Monitor Token Usage**: Check Proxmox logs if tokens suddenly stop working
4. **Use Separate Tokens**: Create different tokens for different purposes (terraform, monitoring, etc.)

## Proxmox Cluster Token Inconsistencies

### Problem
Tokens work on some nodes but fail with 401 on others. Fixing one node breaks another ("whack-a-mole").

### Root Cause
**Proxmox tokens are NOT synced across cluster nodes.** Each node generates its own secret for the same token ID. This is by design in Proxmox and cannot be changed.

**Your setup:**
- **Cluster**: yin.prox + YANG.prox (2-node cluster)
- **Standalone**: proxBig.prox

**Why it's frustrating:**
- Create token on yin → get secret A → works on yin
- Create token on YANG → get secret B → works on YANG
- But if you recreate token on one node, you get a NEW secret
- If `.env` isn't updated immediately, tests fail
- It's a constant battle to keep secrets in sync

### Recommended Solution: Use Single Cluster Endpoint

**Instead of managing separate secrets for each node, use ONE cluster endpoint:**

```bash
# In .env - use YANG as the cluster endpoint
PROXMOX_URL=https://yang.prox:8006
PROXMOX_YIN_URL=https://yin.prox:8006  # Optional, falls back to PROXMOX_URL
PROXMOX_YANG_URL=https://yang.prox:8006
CLUSTER_TF_TOKEN_ID=llm@pve!llm-agent
PROXMOX_CLUSTER_TF_SECRET=<secret-from-YANG-only>

# Remove or comment out node-specific secrets:
# PROXMOX_YIN_TF_SECRET=...  # Not needed if using cluster endpoint
# PROXMOX_YANG_TF_SECRET=... # Not needed if using cluster endpoint
```

**Why this works:**
- Cluster operations can be performed from any cluster node
- YANG can manage VMs on both yin and YANG
- You only need ONE secret (from YANG)
- No more whack-a-mole!

**Codebase behavior:** Proxmox credentials are selected as deterministic `TOKEN_ID + TOKEN_SECRET` pairs. The resolver does not independently mix token IDs and secrets from unrelated env families.

### Alternative: Node-Specific Secrets (If You Must)

If you absolutely need node-specific secrets:

1. **Create tokens on BOTH nodes at the same time**
2. **Update `.env` immediately with BOTH secrets**
3. **Never recreate tokens unless you update `.env` at the same time**

```bash
# Create on yin
ssh root@yin.prox 'pveum user token delete llm@pve llm-agent && pveum user token add llm@pve llm-agent --privsep 0'
# Copy secret → PROXMOX_YIN_TF_SECRET

# Create on YANG  
ssh root@yang.prox 'pveum user token delete llm@pve llm-agent && pveum user token add llm@pve llm-agent --privsep 0'
# Copy secret → PROXMOX_YANG_TF_SECRET

# Update .env IMMEDIATELY
# Then test: bun run scripts/test-proxmox-tokens.ts
```

### Verification

Test all tokens:
```bash
bun run scripts/test-proxmox-tokens.ts
```

Expected: All nodes show ✅ SUCCESS

## VM Not Appearing in Twin

### Problem
After creating a VM, the agent doesn't know about it.

### Root Causes

1. **Twin Sync Failed Silently**: The `create_vm` action syncs to the twin, but failures are non-blocking and may be logged as warnings.

2. **Timing Issue**: The agent queries the twin before sync completes.

3. **Twin Sync Error**: Check logs for "Failed to sync VM to twin" warnings.

### Solutions

#### 1. Check Twin Sync Logs

After creating a VM, check logs for:
```
[INFO] VM synced to twin {"name": "bib", "entities": 1, "relationships": 1}
```

If you see:
```
[WARN] Failed to sync VM to twin (non-critical) {"error": "...", "name": "bib"}
```

The sync failed. Check the error message.

#### 2. Manual Ingestion

If twin sync fails, trigger manual ingestion:
```bash
# Via API
curl -X POST http://localhost:4000/api/ingestion/proxmox

# Or via agent
"run ingestion to update the twin"
```

#### 3. Verify Twin Data

Query the twin directly:
```bash
# Via API
curl http://localhost:4000/api/twin/query?operation=find_vm_by_name&vmName=bib

# Or via agent
"find VM named bib"
```

### Prevention

1. **Monitor Twin Sync**: Check logs after VM creation
2. **Automatic Ingestion**: Consider running periodic ingestion jobs
3. **Error Handling**: Improve error messages in twin sync failures
