# Test Scripts

## Consolidated Token Test

**`test-proxmox-tokens.ts`** - Single comprehensive test for all Proxmox nodes

This script replaces:
- `test-yin-cluster-resources.ts`
- `test-proxmox-nodes.ts`  
- `test-yin-token.sh`
- `test-yang-token.sh`
- `test-terraform-token.sh`

### Usage

```bash
bun run scripts/test-proxmox-tokens.ts
```

### What It Tests

1. **Environment Variables**: Verifies all required env vars are set
2. **Authentication**: Tests `/version` endpoint for each node
3. **Node Access**: Tests `/nodes` endpoint
4. **Cluster Resources**: Tests `/cluster/resources` for cluster nodes (yin/YANG)
5. **Node Status**: Tests `/nodes/{node}/status` for standalone nodes (proxBig)

### Expected Environment Variables

Token selection is now **pair-based**. The resolver only uses complete `TOKEN_ID + TOKEN_SECRET` pairs and does not mix unrelated env families.

#### For proxBig (standalone):
- `PROXBIG_TOKEN_ID` + `PROXBIG_TOKEN_SECRET` (preferred), or
- `PROXBIG_TF_TOKEN_ID` + `PROXBIG_TF_SECRET`, or
- `PROXMOX_PROXBIG_TF_TOKEN_ID` + `PROXMOX_PROXBIG_TF_SECRET`, or
- `PROXMOX_TOKEN_ID` + `PROXBIG_TOKEN_SECRET` (for shared token IDs), or
- `CLUSTER_TF_TOKEN_ID` + `PROXBIG_TF_SECRET`
- URL source: `PROXBIG_URL` then `PROXMOX_URL`

#### For yin (cluster):
- `CLUSTER_TF_TOKEN_ID` + `PROXMOX_YIN_TF_SECRET` (preferred), or
- `CLUSTER_TF_TOKEN_ID` + `PROXMOX_CLUSTER_TF_SECRET`, or
- `PROXMOX_TOKEN_ID` + `YIN_TOKEN_SECRET` / `PROXMOX_YIN_TF_SECRET`
- URL source: `PROXMOX_YIN_URL` then `PROXMOX_URL`

#### For YANG (cluster):
- `CLUSTER_TF_TOKEN_ID` + `PROXMOX_YANG_TF_SECRET` (preferred), or
- `CLUSTER_TF_TOKEN_ID` + `PROXMOX_CLUSTER_TF_SECRET`, or
- `PROXMOX_TOKEN_ID` + `YANG_TOKEN_SECRET` / `PROXMOX_YANG_TF_SECRET`
- URL source: `PROXMOX_YANG_URL` then `PROXMOX_URL`

### Notes

- The script uses the **same env var logic** as the codebase (`create-vm.ts`, `terraform-runner.ts`)
- URLs are normalized to lowercase hostnames (Proxmox node names are case-sensitive but URLs are not)
- 401 errors indicate authentication failure (wrong secret or expired token)
- 403 errors indicate permission issues (token lacks required permissions)
