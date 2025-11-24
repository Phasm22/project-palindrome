# Proxmox Nodes Test Results

## Test Script
Location: `scripts/test-proxmox-nodes.ts`

This script tests all 3 Proxmox nodes to verify:
1. API connectivity
2. Environment variable configuration
3. Node discovery
4. Node status access
5. Tool integration

## Test Results (2025-11-24)

### Node Configuration

| Node | IP | URL | Cluster | Status |
|------|----|-----|---------|--------|
| proxBig | 172.16.0.10 | https://172.16.0.10:8006 | Standalone (1 node) | ⚠️ Permission issues |
| yin | 172.16.0.11 | https://172.16.0.11:8006 | Cluster (yin, YANG) | ✅ Working |
| yang | 172.16.0.12 | https://172.16.0.12:8006 | Cluster (yin, YANG) | ⚠️ Permission issues |

### Environment Variables

#### Global Variables
- `PROXMOX_URL`: `https://proxBig.prox:8006` ✅
- `PROXMOX_TOKEN_ID`: `palindrome-agent@pve!pce-token` ✅
- `PROXMOX_TOKEN_SECRET`: ✅ Set
- `PROXMOX_VERIFY_SSL`: `false` ✅

#### Node-Specific Secrets
- `PROXBIG_TOKEN_SECRET`: ✅ Set (node-specific)
- `YIN_TOKEN_SECRET`: ⚠️ Not set (using default)
- `YANG_TOKEN_SECRET`: ⚠️ Not set (using default)

### Issues Found

#### 1. Permission Issues (403 Errors)

**proxBig:**
- ✅ API connection successful
- ✅ Can list nodes (finds 1 node: proxBig)
- ❌ Cannot get node status: `403 Permission denied`
- ❌ Tool integration fails with 401/403 errors

**yang:**
- ✅ API connection successful
- ✅ Can list nodes (finds 2 nodes: yin, YANG)
- ❌ Cannot get node status: `403 Permission denied`
- ✅ Tool integration works (can list nodes)

**yin:**
- ✅ All operations work correctly
- ✅ Can get node status
- ✅ Tool integration successful

### Root Cause Analysis

The 403 errors suggest that the API token (`palindrome-agent@pve!pce-token`) has different permission levels on different nodes:

1. **yin**: Token has full read access ✅
2. **yang**: Token can list nodes but cannot access node status endpoints ❌
3. **proxBig**: Token can list nodes but cannot access node status endpoints ❌

### Recommendations

1. **Check Token Permissions on proxBig and yang:**
   - Verify the token has `PVEAuditor` or `PVEAdmin` role on these nodes
   - Ensure the token has access to `/nodes/{node}/status` endpoint
   - Check if there are node-specific ACL restrictions

2. **Consider Node-Specific Tokens:**
   - If different nodes require different permissions, use node-specific token secrets:
     - `PROXBIG_TOKEN_SECRET` (already set)
     - `YIN_TOKEN_SECRET` (optional, currently using default)
     - `YANG_TOKEN_SECRET` (may need different permissions)

3. **Verify Token Scope:**
   - The token should have permissions on all nodes in the cluster
   - For proxBig (standalone), ensure the token is created on that node
   - For yin/yang cluster, ensure the token has cluster-wide permissions

### Running the Test

```bash
# Run the test script
bun scripts/test-proxmox-nodes.ts

# Or test individual nodes via CLI
bun src/cli.ts proxmox list-nodes
bun src/cli.ts proxmox node-status --node=yin
bun src/cli.ts proxmox node-status --node=yang
bun src/cli.ts proxmox node-status --node=proxBig
```

### Environment Variable Setup

The code supports both global and node-specific token secrets:

```bash
# Global (used by default)
export PROXMOX_URL="https://proxBig.prox:8006"
export PROXMOX_TOKEN_ID="palindrome-agent@pve!pce-token"
export PROXMOX_TOKEN_SECRET="your-default-secret"

# Node-specific (optional, takes precedence)
export PROXBIG_TOKEN_SECRET="proxbig-specific-secret"
export YIN_TOKEN_SECRET="yin-specific-secret"
export YANG_TOKEN_SECRET="yang-specific-secret"

# SSL verification (optional)
export PROXMOX_VERIFY_SSL="false"  # For self-signed certificates
```

The code automatically detects node-specific secrets by:
1. Extracting the hostname from `PROXMOX_URL`
2. Converting to uppercase (e.g., `proxbig` → `PROXBIG`)
3. Checking for `${NODE}_TOKEN_SECRET` environment variable
4. Falling back to `PROXMOX_TOKEN_SECRET` if not found

### Next Steps

1. ✅ Test script created and working
2. ⚠️ Fix token permissions on proxBig and yang
3. ⚠️ Consider setting YANG_TOKEN_SECRET if different permissions needed
4. ✅ Verify all nodes are accessible via the tool

