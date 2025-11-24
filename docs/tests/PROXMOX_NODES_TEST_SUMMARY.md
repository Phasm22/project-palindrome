# Proxmox Nodes Test Summary

## ✅ Test Script Created

**Location:** `scripts/test-proxmox-nodes.ts`

This comprehensive test script verifies:
- API connectivity to all 3 nodes
- Environment variable configuration
- Node discovery and cluster membership
- Node status access
- Tool integration

## 📊 Test Results

### All 3 Nodes Tested Successfully

| Node | IP | Status | Issues |
|------|----|--------|--------|
| **proxBig** | 172.16.0.10 | ✅ API Works | ⚠️ 403 on node status |
| **yin** | 172.16.0.11 | ✅ All Good | None |
| **yang** | 172.16.0.12 | ✅ API Works | ⚠️ 403 on node status |

### Environment Variables ✅

All required environment variables are set correctly:

```bash
PROXMOX_URL=https://proxBig.prox:8006
PROXMOX_TOKEN_ID=palindrome-agent@pve!pce-token
PROXMOX_TOKEN_SECRET=✅ Set
PROXMOX_VERIFY_SSL=false
PROXBIG_TOKEN_SECRET=✅ Set (node-specific)
```

### Issues Found

#### Permission Issues (403 Errors)

**proxBig:**
- Can connect to API ✅
- Can list nodes ✅
- Cannot get node status ❌ (403 Permission denied)
- Tool integration fails with 401/403 ❌

**yang:**
- Can connect to API ✅
- Can list nodes ✅
- Cannot get node status ❌ (403 Permission denied)
- Tool integration works ✅ (can list nodes)

**yin:**
- Everything works perfectly ✅

### Root Cause

The API token (`palindrome-agent@pve!pce-token`) has different permission levels:
- **yin**: Full read access ✅
- **yang**: Can list nodes but not access status endpoints ⚠️
- **proxBig**: Can list nodes but not access status endpoints ⚠️

## 🔧 Environment Variable Usage

The codebase correctly uses environment variables in the following locations:

### ✅ Correctly Implemented

1. **`src/tools/proxmox/readonly/base.ts`** (lines 17-51)
   - Supports node-specific secrets via `getApiConfig()`
   - Checks for `${NODE}_TOKEN_SECRET` based on URL hostname
   - Falls back to `PROXMOX_TOKEN_SECRET`

2. **`src/tools/proxmox/writes/base.ts`** (lines 19-53)
   - Same node-specific secret support as readonly base

3. **`src/tools/proxmox/client.ts`** (lines 342-360)
   - `fromEnvironment()` method uses default `PROXMOX_TOKEN_SECRET`
   - Note: This method doesn't support node-specific secrets, but it's not used by the tools (they use `getApiConfig()` from base classes)

### How Node-Specific Secrets Work

The code automatically detects node-specific secrets:

1. Extracts hostname from `PROXMOX_URL` (e.g., `proxBig.prox` → `proxBig`)
2. Converts to uppercase (e.g., `PROXBIG`)
3. Checks for `${NODE}_TOKEN_SECRET` (e.g., `PROXBIG_TOKEN_SECRET`)
4. Falls back to `PROXMOX_TOKEN_SECRET` if not found

**Example:**
```bash
# If PROXMOX_URL=https://proxBig.prox:8006
# The code will check for PROXBIG_TOKEN_SECRET first
# Then fall back to PROXMOX_TOKEN_SECRET
```

## 🚀 Running Tests

### Test All Nodes
```bash
bun scripts/test-proxmox-nodes.ts
```

### Test Individual Nodes via CLI
```bash
# List nodes from proxBig
PROXMOX_URL=https://172.16.0.10:8006 bun src/cli.ts proxmox list-nodes

# List nodes from yin
PROXMOX_URL=https://172.16.0.11:8006 bun src/cli.ts proxmox list-nodes

# List nodes from yang
PROXMOX_URL=https://172.16.0.12:8006 bun src/cli.ts proxmox list-nodes

# Get node status (requires proper permissions)
bun src/cli.ts proxmox node-status --node=yin
bun src/cli.ts proxmox node-status --node=yang
bun src/cli.ts proxmox node-status --node=proxBig
```

## 📝 Recommendations

### 1. Fix Token Permissions

The token needs proper permissions on all nodes:

**For proxBig:**
- Verify token has `PVEAuditor` or `PVEAdmin` role
- Ensure access to `/nodes/proxBig/status` endpoint
- Check node-specific ACL restrictions

**For yang:**
- Verify token has `PVEAuditor` or `PVEAdmin` role
- Ensure access to `/nodes/yang/status` endpoint
- Check cluster-wide permissions

### 2. Optional: Node-Specific Tokens

If different nodes require different permissions, you can set:

```bash
export YIN_TOKEN_SECRET="yin-specific-secret"    # Optional
export YANG_TOKEN_SECRET="yang-specific-secret"   # May need different permissions
export PROXBIG_TOKEN_SECRET="proxbig-secret"      # Already set ✅
```

### 3. Verify Token Scope

- For **proxBig** (standalone): Ensure token is created on that node
- For **yin/yang** (cluster): Ensure token has cluster-wide permissions

## ✅ Verification Complete

- ✅ Test script created and working
- ✅ Environment variables verified
- ✅ All 3 nodes can connect to API
- ⚠️ Permission issues identified on proxBig and yang
- ✅ Code correctly uses environment variables with node-specific secret support

## Next Steps

1. **Fix token permissions** on proxBig and yang nodes
2. **Test node status endpoints** after fixing permissions
3. **Consider setting YANG_TOKEN_SECRET** if different permissions needed
4. **Re-run test script** to verify fixes

