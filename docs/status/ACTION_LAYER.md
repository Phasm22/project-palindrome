# Action Layer Status

**Status:** ✅ Foundation Complete

## Components

- **TerraformRunner** - Executes terraform (plan/apply/destroy) with env var handling
- **AnsibleRunner** - Executes ansible playbooks
- **TwinSync** - Syncs terraform state → twin
- **CreateVM Action** - Create VMs with twin validation

## Environment Variables

Required:
- `PROXMOX_URL` - Proxmox API endpoint
- `CLUSTER_TF_TOKEN_ID` or `PROXBIG_TF_TOKEN_ID` - Terraform token ID
- `PROXMOX_CLUSTER_TF_SECRET` or `PROXMOX_PROXBIG_TF_SECRET` - Token secret

Optional:
- `SSH_PUBLIC_KEY` - SSH key (terraform can read from ~/.ssh/id_ed25519.pub)

## Usage

```typescript
import { createVm } from "./src/actions/compute/create-vm";

await createVm({
  name: "test-vm",
  node: "proxBig",
  cores: 1,
  memory: 1024,
  diskSize: "8G",
  dryRun: true,
});
```

## Testing

```bash
# Validate environment
bun scripts/test-action-env.ts

# Test create-vm (dry-run)
bun scripts/test-create-vm-dryrun.ts
```

## Notes

- Plan operations use `-lock=false` (read-only, safe)
- Apply operations use locking (required for safety)
- 5 minute timeout on terraform commands
- Non-interactive mode (`-input=false`)


