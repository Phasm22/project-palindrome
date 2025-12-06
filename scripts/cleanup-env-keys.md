# .env Cleanup Guide - Proxmox Keys

## Keys to REMOVE (cluster token simplification)

For the **TF (Terraform) user** cluster operations, use ONE cluster secret instead of per-node secrets:

```bash
# ❌ REMOVE these (node-specific cluster secrets):
PROXMOX_YIN_TF_SECRET=bc331b6d-62f5-44d4-841e-c129373c4aa7
PROXMOX_YANG_TF_SECRET=801e7418-8b94-42c4-8445-160dd15fac5b

# ✅ ADD this (single cluster secret - use YANG's secret):
PROXMOX_CLUSTER_TF_SECRET=801e7418-8b94-42c4-8445-160dd15fac5b
```

## Keys to REMOVE (redundant proxBig keys)

```bash
# ❌ REMOVE (redundant - same as CLUSTER_TF_TOKEN_ID):
PROXBIG_TF_TOKEN_ID=llm@pve!llm-agent

# ❌ REMOVE (redundant - use PROXBIG_TF_SECRET instead):
PROXBIG_TOKEN_SECRET=a190ddfa-04af-4302-a4e7-3c5888214393
```

## Keys to KEEP

### TF (Terraform) User
```bash
CLUSTER_TF_TOKEN_ID=llm@pve!llm-agent          # Cluster token ID
PROXMOX_CLUSTER_TF_SECRET=<YANG-secret>        # Single cluster secret
PROXBIG_TF_SECRET=a3ef8942-5f69-40c0-9273-309adcf8f4d5  # proxBig standalone
```

### Palindrome User (for PCE/read-only operations)
```bash
PROXMOX_TOKEN_ID=palindrome-agent@pve!pce-token           # proxBig
PROXMOX_TOKEN_SECRET=1b514ded-36c7-41a0-8e50-99bbdc279f2f # proxBig
PROXMOX_YIN_TOKEN_ID=palindrome-agent@pve!pce-token       # yin
PROXMOX_YIN_TOKEN_SECRET=<need-to-add>                     # yin (missing!)
```

### URLs
```bash
PROXMOX_URL=https://proxBig.prox:8006/api2/json
PROXMOX_YIN_URL=https://yin.prox:8006/api2/json
PROXMOX_YANG_URL=https://YANG.prox:8006/api2/json
```

### SSL
```bash
PROXMOX_VERIFY_SSL=false
PROXMOX_YIN_VERIFY_SSL=false
```

## Summary

**Remove 4 keys:**
1. `PROXMOX_YIN_TF_SECRET`
2. `PROXMOX_YANG_TF_SECRET`
3. `PROXBIG_TF_TOKEN_ID`
4. `PROXBIG_TOKEN_SECRET`

**Add 1 key:**
1. `PROXMOX_CLUSTER_TF_SECRET=801e7418-8b94-42c4-8445-160dd15fac5b` (use YANG's secret)

**Add 1 missing key:**
1. `PROXMOX_YIN_TOKEN_SECRET=<yin-palindrome-secret>` (for palindrome user on yin)

