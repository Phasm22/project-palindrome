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

#### For proxBig (standalone):
- `PROXMOX_URL` - Proxmox API URL
- `CLUSTER_TF_TOKEN_ID` or `PROXBIG_TF_TOKEN_ID` - Token ID
- `PROXMOX_PROXBIG_TF_SECRET` or `PROXBIG_TF_SECRET` or `PROXBIG_TOKEN_SECRET` or `PROXMOX_CLUSTER_TF_SECRET` - Token secret

#### For yin (cluster):
- `PROXMOX_YIN_URL` or `PROXMOX_URL` - Proxmox API URL
- `CLUSTER_TF_TOKEN_ID` - Token ID
- `PROXMOX_YIN_TF_SECRET` or `PROXMOX_CLUSTER_TF_SECRET` - Token secret

#### For YANG (cluster):
- `PROXMOX_YANG_URL` or `PROXMOX_URL` - Proxmox API URL
- `CLUSTER_TF_TOKEN_ID` - Token ID
- `PROXMOX_YANG_TF_SECRET` or `PROXMOX_CLUSTER_TF_SECRET` - Token secret

### Notes

- The script uses the **same env var logic** as the codebase (`create-vm.ts`, `terraform-runner.ts`)
- URLs are normalized to lowercase hostnames (Proxmox node names are case-sensitive but URLs are not)
- 401 errors indicate authentication failure (wrong secret or expired token)
- 403 errors indicate permission issues (token lacks required permissions)

