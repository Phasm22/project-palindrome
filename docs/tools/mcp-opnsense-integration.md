# MCP OPNsense Integration

## Overview

The MCP OPNsense tool provides access to 88+ OPNsense operations via the Model Context Protocol (MCP) server. Instead of creating individual tool classes for each operation, we use a **hybrid module/action pattern** that groups related operations into logical modules.

## Architecture

### Module-Based Organization

OPNsense MCP tools are organized into 10 logical modules:

- **core**: Core system operations (systemStatus, backups, snapshots, etc.)
- **firewall**: Firewall rules, aliases, categories, NAT
- **interfaces**: Network interfaces, VLANs, virtual IPs
- **routing**: Static routes, gateways, routing tables
- **dhcp**: DHCP server configuration and leases
- **dns**: DNS/unbound configuration and queries
- **vpn**: VPN configurations (IPsec, OpenVPN, WireGuard)
- **system**: System settings, users, backups, logs
- **diagnostics**: Diagnostic tools, monitoring, logs
- **firmware**: Firmware updates, plugins, packages

### Auto-Discovery

The tool automatically:
1. Connects to the MCP server on initialization
2. Discovers all available tools (88+ operations)
3. Groups them by module based on naming patterns
4. Exposes them via a unified `module/action` interface

## Usage

### Via Agent

The agent can use MCP tools naturally:

```bash
bun run src/cli.ts ask "What's the system status of OPNsense?"
bun run src/cli.ts ask "List all firewall aliases"
bun run src/cli.ts ask "Show me the disk usage"
```

The agent will automatically:
1. Recognize it needs OPNsense data
2. Call `mcp_opnsense` with appropriate module/action
3. Process the results

### Via CLI (Direct Testing)

```bash
# List available modules
bun run src/cli.ts mcp-opnsense modules

# Call a specific operation
bun run src/cli.ts mcp-opnsense core systemStatus
bun run src/cli.ts mcp-opnsense firewall list_rules
bun run src/cli.ts mcp-opnsense interfaces list

# With parameters (JSON)
bun run src/cli.ts mcp-opnsense core manage '{"method": "systemStatus"}'

# With parameters (key=value)
bun run src/cli.ts mcp-opnsense firewall search_aliases search_term=example
```

## Module-Specific Patterns

### Core Module

The `core` module uses a special pattern where actions are method names:

```bash
# These are equivalent:
bun run src/cli.ts mcp-opnsense core systemStatus
bun run src/cli.ts mcp-opnsense core manage '{"method": "systemStatus"}'
```

Available methods include:
- `systemStatus` - Get system status
- `backupBackups` - List backups
- `snapshotsList` - List snapshots
- `serviceRestart` - Restart a service
- And 40+ more (see MCP server documentation)

### Other Modules

Most other modules use direct action names:

```bash
# Firewall module
bun run src/cli.ts mcp-opnsense firewall list_rules
bun run src/cli.ts mcp-opnsense firewall search_aliases
bun run src/cli.ts mcp-opnsense firewall get_rule

# Interfaces module
bun run src/cli.ts mcp-opnsense interfaces list
bun run src/cli.ts mcp-opnsense interfaces get_interface
```

## Configuration

The MCP tool uses environment variables from your `.env` file:

```bash
OPNSENSE_URL=https://172.16.0.1
OPNSENSE_API_KEY=your_api_key
OPNSENSE_API_SECRET=your_api_secret
OPNSENSE_VERIFY_SSL=false
```

Optional MCP-specific variables:

```bash
MCP_OPNSENSE_COMMAND=npx
MCP_OPNSENSE_ARGS='["-y", "@richard-stovall/opnsense-mcp-server"]'
```

## Implementation Details

### MCP Client

The `MCPClient` class (`src/utils/mcp-client.ts`) handles:
- JSON-RPC 2.0 communication with MCP servers
- Tool discovery via `tools/list`
- Tool execution via `tools/call`
- Error handling and timeouts

### Tool Class

The `MCPOpnsenseTool` class (`src/tools/MCPOpnsenseTool.ts`) provides:
- Module-based grouping of 88+ tools
- Auto-discovery on initialization
- Module/action parameter validation
- Special handling for core module methods

### Schema

The Zod schema (`src/tools/schemas/mcp-opnsense.ts`) defines:
- Module enum (10 modules)
- Action string (auto-discovered)
- Optional parameters object

## Benefits of Hybrid Approach

### ✅ Scalability
- **88+ tools** → **10 modules** (much more manageable)
- Auto-discovery means no manual tool registration
- Easy to add new modules or actions

### ✅ Developer Experience
- Single tool class handles all operations
- Logical grouping makes it easier to find operations
- Type-safe with Zod validation

### ✅ LLM Understanding
- Module names are intuitive (firewall, system, etc.)
- Action names are descriptive
- Better than 88 individual tool names

### ✅ Flexibility
- Can still create specific tools for complex cases
- Module grouping can be customized
- Easy to add custom logic per module

## Testing

```bash
# Run unit tests
bun test tests/mcp-client.test.ts
bun test tests/mcp-opnsense.test.ts

# Test CLI commands
bun run src/cli.ts mcp-opnsense modules
bun run src/cli.ts mcp-opnsense core systemStatus

# Test via agent
bun run src/cli.ts ask "What's the OPNsense system status?"
```

## Troubleshooting

### Tool Not Available

If `mcp_opnsense` doesn't appear in available tools:
1. Check environment variables are set
2. Verify MCP server can be started (`npx -y @richard-stovall/opnsense-mcp-server`)
3. Check network connectivity to OPNsense

### Action Not Found

If an action isn't found:
1. List modules: `bun run src/cli.ts mcp-opnsense modules`
2. Check MCP server documentation for available methods
3. For core module, try using method name directly (e.g., `systemStatus`)

### Connection Errors

If MCP connection fails:
1. Verify OPNsense credentials
2. Check OPNsense URL is accessible
3. Review MCP server logs (stderr output)

## Future Enhancements

- [ ] Cache discovered tools to avoid re-discovery
- [ ] Add module-specific help/autocomplete
- [ ] Support for streaming responses
- [ ] Better error messages with suggestions
- [ ] Tool usage analytics per module
- [ ] Rate limiting per module

