# OPNsense Integration

## API Architecture

Tool selection hierarchy:
1. mcp_opnsense - Partial coverage (convenience, not full replacement)
2. opnsense_readonly - Secondary (aliases, simple REST)
3. ssh_execute - Primary for firewall rules (full coverage, reliable)

Note: MCP server v0.6.0 uses module_manage pattern. Firewall rules listing via `firewall_manage.filterBaseGet` returns 404 on OPNsense 25.7. SSH fallback remains primary for firewall rules.

## REST API Limitations

OPNsense REST API exposes ~20-30% of backend functionality.

Missing endpoints:
- /api/firewall/rule/search
- /api/firewall/rule/searchRule
- /api/firewall/rule/list
- /api/firewall/filter/search
- NAT listing
- DHCP leases (unstable)
- Diagnostics (incomplete)
- System logs
- Plugin information

Existing endpoints:
- GET /api/firewall/rule/getRule/{uuid}
- POST /api/firewall/rule/setRule/{uuid}
- POST /api/firewall/rule/addRule
- POST /api/firewall/rule/delRule/{uuid}
- POST /api/firewall/alias/searchItem

## Tool Usage

### mcp_opnsense
Use for: system status, core operations, interfaces (partial), diagnostics (partial)
Limitations: Firewall rules listing returns 404. Use SSH fallback for firewall rules.
Examples:
- mcp_opnsense core systemStatus
- mcp_opnsense firewall manage '{"method": "aliasSearchItem"}'
- mcp_opnsense interfaces manage '{"method": "list"}'

### opnsense_readonly
Use for: firewall aliases only
Examples:
- opnsense_readonly firewall_aliases_list
- opnsense_readonly firewall_aliases_get

### ssh_execute
Use for: config file parsing, system-level operations

## Performance Issues

Firewall rules via SSH: 42s (sequential execution)
- 4 commands executed sequentially
- Each command ~10s
- Fix: Parallelize with Promise.all() → ~10s expected

## Implementation Status

Completed:
- Removed non-existent API endpoint attempts
- Updated system prompt to reflect SSH as primary for firewall rules
- Updated tool descriptions
- Added MCPOpnsenseTool to tool loader
- MCP server connection working (24 tools discovered)

MCP Server Status:
- MCP server v0.6.0 (Modular Edition) uses module_manage pattern
- All 24 tools use `*_manage` pattern (core_manage, firewall_manage, interfaces_manage, etc.)
- No `firewall_list_rules` tool exists in this version
- `firewall_manage.filterBaseGet` returns 404 on OPNsense 25.7
- MCP provides partial coverage (convenience), not full replacement
- SSH fallback remains primary for firewall rules (full coverage, reliable)

Next Steps:
- Optimize SSH fallback (parallelize commands - Priority 1)
- Monitor MCP server updates for firewall rules support
- Use MCP for operations that work (system status, core operations)

Pending:
- Identify correct method name for firewall_manage to list rules
- Migrate firewall rules to MCP (once method identified)
- Parallelize SSH commands (fallback optimization)

## Environment Variables

Required:
- OPNSENSE_URL
- OPNSENSE_API_KEY
- OPNSENSE_API_SECRET
- OPNSENSE_VERIFY_SSL

Same variables used for both REST API and MCP server.

