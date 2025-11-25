# API Discovery Setup Guide

## Prerequisites

The API discovery system requires proper authentication and permissions for each service.

## Proxmox Setup

### 1. Environment Variables

Set these environment variables before running discovery:

```bash
export PROXMOX_URL="https://proxBig.prox:8006"
export PROXMOX_TOKEN_ID="palindrome-agent@pve!pce-token"
export PROXMOX_TOKEN_SECRET="<your-token-secret>"
export PROXMOX_VERIFY_SSL="false"  # Optional, for self-signed certs
```

**Alternative variable names** (also supported):
- `PROXMOX_API_HOST` instead of `PROXMOX_URL`
- `PROXMOX_API_TOKEN_ID` instead of `PROXMOX_TOKEN_ID`
- `PROXMOX_API_TOKEN_SECRET` instead of `PROXMOX_TOKEN_SECRET`

### 2. Token Permissions

The Proxmox token **must have read permissions** to discover endpoints.

#### Minimum Required Role

```bash
# Assign built-in PVEAuditor role (read-only audit access)
pveum aclmod / -user palindrome-agent@pve -role PVEAuditor
```

#### Custom Role (Alternative)

```bash
# Create custom auditor role
pveum roleadd PCEAuditor -privs "Datastore.Audit Sys.Audit VM.Audit SDN.Audit Nodes.Audit"

# Assign to user
pveum aclmod / -user palindrome-agent@pve -role PCEAuditor
```

#### Verify Permissions

```bash
# Check user permissions
pveum user permissions --user palindrome-agent@pve --path /
```

Should show:
```
ACL path │ Permissions
/        │ PVEAuditor
```

### 3. Test Authentication

Before running discovery, test that authentication works:

```bash
curl -k -H "Authorization: PVEAPIToken=palindrome-agent@pve!pce-token=<secret>" \
    https://proxBig.prox:8006/api2/json/version
```

If this returns 401, check:
- Token ID and secret are correct
- Token has been assigned a role with permissions
- User exists in Proxmox

### 4. Standalone vs Cluster Nodes

**Standalone nodes** (like proxBig):
- Discovery will only probe `/nodes/<node>/*` endpoints
- Cluster endpoints (`/cluster/*`) are skipped
- Global endpoints (`/version`, `/nodes`, `/storage`) require global permissions

**Cluster nodes** (like yin, yang):
- Discovery probes both node and cluster endpoints
- Requires global permissions for cluster endpoints

## OPNsense Setup

### 1. Environment Variables

```bash
export OPNSENSE_URL="https://172.16.0.1"
export OPNSENSE_API_KEY="<your-api-key>"
export OPNSENSE_API_SECRET="<your-api-secret>"
export OPNSENSE_VERIFY_SSL="false"  # Optional, for self-signed certs
```

### 2. API Key Permissions

The OPNsense API key needs appropriate permissions for the modules you want to discover:
- Firewall (for firewall endpoints)
- System (for system endpoints)
- Interfaces (for interface endpoints)
- DHCP (for DHCP endpoints)

## Running Discovery

### Basic Usage

```bash
# Discover all services
bun run scripts/discover-api-endpoints.ts --service=all

# Discover specific service
bun run scripts/discover-api-endpoints.ts --service=proxmox
bun run scripts/discover-api-endpoints.ts --service=opnsense
```

### Expected Output

**Success:**
```
🔍 Starting API endpoint discovery...
✅ Registered Proxmox discovery service
🔎 Discovering endpoints...
📊 PROXMOX
   Discovered 15 endpoints
   Enabled actions: 17
   Missing endpoints: 2
   Enabled but not discovered: 0
```

**Authentication Failure:**
```
❌ Proxmox authentication failed: 401 Unauthorized
   This usually means:
   1. Token ID or secret is incorrect
   2. Token has no ACLs/permissions assigned
   Fix: Run 'pveum aclmod / -user <user> -role PVEAuditor'
⚠️  Skipping Proxmox discovery
```

**Missing Environment Variables:**
```
⚠️  Proxmox discovery skipped: Missing required environment variables
   Required: PROXMOX_URL (or PROXMOX_API_HOST), PROXMOX_TOKEN_ID, PROXMOX_TOKEN_SECRET
   Current values:
     PROXMOX_URL: ✓
     PROXMOX_TOKEN_ID: ✗
     PROXMOX_TOKEN_SECRET: ✗
```

## Troubleshooting

### Proxmox: 401 Unauthorized

**Cause**: Token lacks permissions or credentials are wrong

**Fix**:
1. Verify token ID and secret are correct
2. Assign PVEAuditor role: `pveum aclmod / -user palindrome-agent@pve -role PVEAuditor`
3. Verify permissions: `pveum user permissions --user palindrome-agent@pve --path /`

### Proxmox: 0 Endpoints Discovered

**Cause**: Token is node-scoped and node is standalone, or token has no permissions

**Fix**:
1. Check if token has global access (try `/version` endpoint manually)
2. For standalone nodes, ensure token has permissions at `/nodes/<node>`
3. Discovery will only find node-scoped endpoints for node-scoped tokens

### OPNsense: Partial Discovery

**Cause**: OPNsense API is fragmented - many endpoints require POST with payloads

**Status**: This is expected. Discovery finds endpoints that accept GET requests. POST-only endpoints require manual addition.

## Output Files

Discovery results are saved to:
- `docs/technical/api-discovery-results/discovery-{timestamp}.json` - All discovered endpoints
- `docs/technical/api-discovery-results/gap-analysis-{timestamp}.json` - Gap analysis report

## Next Steps

After successful discovery:
1. Review gap analysis to identify missing endpoints
2. Prioritize high-value endpoints for tool implementation
3. Update tool schemas with discovered endpoints
4. Re-run discovery periodically to catch API changes

