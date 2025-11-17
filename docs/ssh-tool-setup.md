# SSH Tool Setup Guide

## Overview

The SSH tool allows the agent to execute pre-approved read-only commands on lab hosts for filesystem analysis and system diagnostics.

## Configuration

### 1. Approved Commands

Edit `src/config/approved-commands.yaml` to add hosts and their approved commands:

```yaml
hosts:
  "172.16.0.1":
    hostname: "172.16.0.1"
    description: "OPNsense firewall"
    read_only: true
    commands:
      filesystem:
        - "du -sh /*"
        - "df -h"
      system:
        - "uptime"
```

### 2. SSH Credentials

Set environment variables for SSH authentication:

**Option 1: SSH Key (Recommended)**
```bash
export SSH_KEY_172_16_0_1="$(cat ~/.ssh/id_rsa)"
# Or set SSH_KEY_PATH to use default key
export SSH_KEY_PATH="$HOME/.ssh/id_rsa"
```

**Option 2: Password**
```bash
export SSH_USER_172_16_0_1="root"
export SSH_PASSWORD_172_16_0_1="your-password"
```

**Option 3: Default User**
```bash
export SSH_USER="root"  # Default for all hosts
```

### 3. Environment Variable Format

For hosts with dots in IP addresses, replace dots with underscores:
- `172.16.0.1` → `SSH_USER_172_16_0_1`
- `192.168.1.100` → `SSH_USER_192_168_1_100`

## Usage

### CLI Testing
```bash
# Test SSH command directly
bun run src/cli.ts ssh 172.16.0.1 "du -sh /*"

# Via agent
bun run src/cli.ts ask "why is the disk so full on opnsense?"
```

### Agent Usage

The agent will automatically:
1. Check if command is approved for the host
2. Execute via SSH
3. Return structured results
4. Use results to answer questions

## Security

- **Pre-approved commands only**: Commands must be in `approved-commands.yaml`
- **Read-only by default**: All commands should be read-only
- **Host whitelist**: Only configured hosts can be accessed
- **No command injection**: Commands are validated before execution

## Adding New Commands

1. Edit `src/config/approved-commands.yaml`
2. Add command to appropriate category (filesystem, system, etc.)
3. Restart agent (or it will reload on next tool call)

## Example: Filesystem Analysis

```bash
# Check directory sizes
bun run src/cli.ts ssh 172.16.0.1 "du -sh /*"

# Find large files
bun run src/cli.ts ssh 172.16.0.1 "find /var -type f -size +100M 2>/dev/null"

# Check log directory
bun run src/cli.ts ssh 172.16.0.1 "du -h --max-depth=1 /var/log"
```

