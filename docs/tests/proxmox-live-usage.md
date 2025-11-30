# Using the Agent with Live Proxmox

This guide shows how to use the Proxmox read-only tool with a live Proxmox cluster (not mocks).

## Prerequisites

1. **Proxmox VE cluster** running and accessible
2. **Proxmox API token** created with appropriate permissions
3. **Environment variables** configured

## Step 1: Create Proxmox API Token

1. Log into your Proxmox web UI
2. Go to **Datacenter** → **Permissions** → **API Tokens**
3. Click **Add** → **API Token**
4. Configure:
   - **User**: Select a user (e.g., `root@pam` or create a dedicated user)
   - **Token ID**: Give it a name (e.g., `agent-readonly`)
   - **Privilege Separation**: Enable if you want to limit permissions
   - **Expiration**: Set as needed (or leave blank for no expiration)
5. **Copy the token secret** immediately (you won't see it again!)

The token format will be: `user@realm!tokenname=secret`

## Step 2: Configure Environment Variables

Create or update your `.env` file in the project root:

```bash
# Proxmox Configuration
PROXMOX_URL=https://your-proxmox-host.example.com
PROXMOX_TOKEN_ID=user@realm!tokenname
PROXMOX_TOKEN_SECRET=your-token-secret-here

# Optional: Disable SSL verification (only for self-signed certs)
# PROXMOX_VERIFY_SSL=false

# OpenAI API Key (required for agent queries)
OPENAI_API_KEY=sk-your-openai-key

# PCE API URL (optional, for RAG context)
PCE_API_URL=http://localhost:4000

# User/ACL configuration (optional)
PCE_USER_ID=your-user-id
PCE_ACL_GROUP=viewer  # or "ops", "admin"
```

**Example**:
```bash
PROXMOX_URL=https://yin.prox:8006
PROXMOX_TOKEN_ID=root@pam!agent-readonly
PROXMOX_TOKEN_SECRET=abc123-def456-ghi789-...
OPENAI_API_KEY=sk-...
```

## Step 3: Verify Configuration

Test the connection directly:

```bash
# Test direct Proxmox API access
curl -k -H "Authorization: PVEAPIToken=root@pam!agent-readonly=abc123..." \
  https://yin.prox:8006/api2/json/version
```

Or use the CLI to test:

```bash
# List nodes (tests connection)
bun src/cli.ts proxmox list-nodes
```

## Step 4: Using the Agent

### Option 1: Direct Proxmox CLI Commands

Use the `agent proxmox` command for direct tool access:

```bash
# List all nodes
bun src/cli.ts proxmox list-nodes

# Get node status
bun src/cli.ts proxmox node-status --node=pve1

# Get node resources
bun src/cli.ts proxmox node-resources --node=pve1

# List VMs on a node
bun src/cli.ts proxmox list-vms --node=pve1

# Get VM status
bun src/cli.ts proxmox vm-status --node=pve1 --vmid=101

# Get VM configuration
bun src/cli.ts proxmox vm-config --node=pve1 --vmid=101

# Get cluster status
bun src/cli.ts proxmox cluster-status

# Get cluster resources
bun src/cli.ts proxmox cluster-resources

# JSON output
bun src/cli.ts proxmox list-nodes --json
```

### Option 2: Agent Queries (LLM + Tools)

Use the `agent ask` or `agent pce` command for natural language queries that will automatically use Proxmox tools (both commands are equivalent):

```bash
# Simple query - agent will use Proxmox tools automatically
agent ask "What nodes are in my Proxmox cluster?"
# Or use 'pce' (alias for 'ask')
agent pce "What nodes are in my Proxmox cluster?"

# Query about VM status
bun src/cli.ts pce "Is VM 101 running? What's its CPU usage?"

# Query about cluster resources
bun src/cli.ts pce "Which node has the most available memory?"

# Complex query combining multiple tools
bun src/cli.ts pce "Where is VM 101 running, how overloaded is that node, and what is the safest failover target?"

# Query with RAG context (if PCE API is running)
bun src/cli.ts pce "Based on our infrastructure runbooks, should we reboot VM 101 if it's at 95% CPU?"
```

The agent will:
1. Analyze your query
2. Automatically select appropriate Proxmox tools
3. Execute the tools against your live cluster
4. Synthesize a natural language answer
5. Include provenance metadata for all tool calls

## Step 5: Example Queries

### Basic Information Queries

```bash
# Cluster overview
bun src/cli.ts pce "Give me an overview of my Proxmox cluster"

# Node health check
bun src/cli.ts pce "Check the health of all nodes in the cluster"

# VM inventory
bun src/cli.ts pce "List all VMs and their current status"
```

### Resource Monitoring Queries

```bash
# Resource usage
bun src/cli.ts pce "Which node has the most CPU usage?"

# Memory analysis
bun src/cli.ts pce "Show me memory usage across all nodes"

# VM resource usage
bun src/cli.ts pce "What are the resource limits for VM 101?"
```

### Troubleshooting Queries

```bash
# VM status check
bun src/cli.ts pce "Is VM 101 running? What's its current state?"

# Network information
bun src/cli.ts pce "What network interfaces does VM 101 have?"

# Snapshot information
bun src/cli.ts pce "What snapshots exist for VM 101?"
```

### Complex Hybrid Queries (with RAG)

If you have the PCE API running with ingested Proxmox documentation:

```bash
# Query combining live data + documentation
bun src/cli.ts pce "VM 101 is at 95% CPU. Based on our runbooks, should we reboot it?"

# Query about failover procedures
bun src/cli.ts pce "Where is VM 101 running, and what's the recommended failover procedure?"
```

## Troubleshooting

### Connection Issues

```bash
# Test if Proxmox is reachable
ping your-proxmox-host.example.com

# Test HTTPS connection
curl -k https://your-proxmox-host.example.com:8006/api2/json/version

# Check if token is valid
curl -k -H "Authorization: PVEAPIToken=user@realm!token=secret" \
  https://your-proxmox-host.example.com:8006/api2/json/version
```

### SSL Certificate Issues

If you have a self-signed certificate:

```bash
# Add to .env
PROXMOX_VERIFY_SSL=false
```

### Permission Issues

Make sure your API token has the necessary permissions:
- **Sys.Audit** - Required for read-only operations
- **Datastore.Audit** - For storage information
- **VM.Audit** - For VM information

### Debug Mode

Enable debug logging:

```bash
# Set log level
export LOG_LEVEL=debug

# Run with verbose output
bun src/cli.ts proxmox list-nodes
```

## Environment Variable Reference

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `PROXMOX_URL` | Yes | Proxmox API endpoint | `https://yin.prox:8006` |
| `PROXMOX_TOKEN_ID` | Yes | API token ID | `root@pam!agent-readonly` |
| `PROXMOX_TOKEN_SECRET` | Yes | API token secret | `abc123-def456-...` |
| `PROXMOX_VERIFY_SSL` | No | Verify SSL certs (default: true) | `false` |
| `OPENAI_API_KEY` | Yes (for agent) | OpenAI API key | `sk-...` |
| `PCE_API_URL` | No | PCE API for RAG context | `http://localhost:4000` |
| `PCE_USER_ID` | No | User ID for ACL | `default-user` |
| `PCE_ACL_GROUP` | No | ACL group | `viewer`, `ops`, `admin` |

## Security Notes

1. **Never commit `.env` file** - Add it to `.gitignore`
2. **Use least-privilege tokens** - Create dedicated read-only tokens
3. **Rotate tokens regularly** - Set expiration dates
4. **Use HTTPS** - Always use encrypted connections
5. **Restrict network access** - Limit Proxmox API access to trusted networks

## Next Steps

- **Ingest Proxmox data into PCE**: Use the vector and graph ingestion features to cache Proxmox state
- **Set up monitoring**: Create queries that run periodically to monitor cluster health
- **Integrate with automation**: Use the agent in scripts for automated operations

