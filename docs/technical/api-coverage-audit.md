# API Coverage Audit - Automated Discovery System

## Objective

Automatically discover and ingest all available API routes for OPNsense and Proxmox, then cross-reference with currently enabled actions to ensure we are not overly restrictive.

## Status

🚧 **IN PROGRESS** - Automated discovery framework implemented

## Approach: Automated Discovery vs Manual Documentation

Instead of manually documenting endpoints (which doesn't scale), we now have an **automated discovery system** that:

1. **Runtime Discovery**: Probes APIs to discover available endpoints
2. **Schema Generation**: Automatically generates tool schemas from discovered endpoints
3. **Gap Analysis**: Compares discovered endpoints with enabled actions
4. **Auto-Update**: Can regenerate tool definitions when APIs change

## Implementation

### Discovery Framework

Location: `src/tools/api-discovery/`

- **`discovery-framework.ts`**: Base framework for API discovery
- **`proxmox-discovery.ts`**: Proxmox-specific discovery service
- **`opnsense-discovery.ts`**: OPNsense-specific discovery service

### How It Works

1. **Registration**: Discovery services register themselves
2. **Discovery**: Services probe APIs to find available endpoints
3. **Schema Generation**: Framework generates Zod/JSON schemas from discoveries
4. **Tool Integration**: Generated schemas can update tool definitions automatically

### Usage

```typescript
import { discoveryRegistry } from "./api-discovery";
import { ProxmoxDiscoveryService } from "./proxmox-discovery";

// Register and discover
const proxmoxClient = new ProxmoxClient(config);
discoveryRegistry.register(new ProxmoxDiscoveryService(proxmoxClient));

const results = await discoveryRegistry.discoverAll();
// Results contain all discovered endpoints with metadata
```

## Next Steps

### Immediate Actions

1. **Run Discovery Script**:
   ```bash
   bun run scripts/discover-api-endpoints.ts --service=all
   ```

2. **Review Gap Analysis**:
   - Check `docs/technical/api-discovery-results/gap-analysis-*.json`
   - Identify high-value missing endpoints
   - Prioritize based on use cases

3. **Auto-Generate Tool Updates**:
   - Use discovery results to generate updated tool schemas
   - Integrate with CI/CD to keep tools in sync with APIs

### Future Enhancements

- [ ] **OpenAPI/Swagger Integration**: Use API specs if available
- [ ] **MCP Server Discovery**: Leverage MCP tool definitions
- [ ] **Periodic Re-discovery**: Auto-update when APIs change
- [ ] **Schema Validation**: Validate discovered endpoints against actual responses
- [ ] **Security Classification**: Auto-classify endpoints by risk level

## Legacy Manual Tasks (Replaced by Automated Discovery)

The following tasks are now handled automatically by the discovery system:

### 1. OPNsense API Discovery

- [ ] Document all available OPNsense API endpoints
  - [ ] Core API endpoints (`/api/core/`)
  - [ ] Firewall API endpoints (`/api/firewall/`)
  - [ ] System API endpoints (`/api/system/`)
  - [ ] Interface API endpoints (`/api/interfaces/`)
  - [ ] DHCP API endpoints (`/api/dhcp/`)
  - [ ] Other module endpoints

- [ ] Cross-reference with current `opnsense_readonly` tool actions:
  - [ ] `system_status`
  - [ ] `list_aliases`
  - [ ] `search_aliases`
  - [ ] Any other currently enabled actions

- [ ] Cross-reference with current `opnsense_safewrite` tool actions:
  - [ ] Document all write operations currently enabled
  - [ ] Identify any missing write operations that should be available

- [ ] Identify gaps:
  - [ ] Read-only endpoints not currently exposed
  - [ ] Write endpoints not currently exposed
  - [ ] Endpoints that might be useful but are missing

### 2. Proxmox API Discovery

- [ ] Document all available Proxmox API endpoints
  - [ ] Cluster endpoints (`/api2/json/cluster/`)
  - [ ] Node endpoints (`/api2/json/nodes/{node}/`)
  - [ ] VM endpoints (`/api2/json/nodes/{node}/qemu/`)
  - [ ] LXC endpoints (`/api2/json/nodes/{node}/lxc/`)
  - [ ] Storage endpoints (`/api2/json/storage/`)
  - [ ] Network endpoints (`/api2/json/network/`)
  - [ ] Access endpoints (`/api2/json/access/`)
  - [ ] Other endpoints

- [ ] Cross-reference with current `proxmox_readonly` tool actions:
  - [ ] List all currently enabled read-only actions
  - [ ] Map each action to its corresponding API endpoint(s)
  - [ ] Identify any missing read-only operations

- [ ] Cross-reference with current `proxmox_write` tool actions:
  - [ ] List all currently enabled write actions
  - [ ] Map each action to its corresponding API endpoint(s)
  - [ ] Identify any missing write operations

- [ ] Identify gaps:
  - [ ] Read-only endpoints not currently exposed
  - [ ] Write endpoints not currently exposed
  - [ ] Endpoints that might be useful but are missing

### 3. Analysis & Recommendations

- [ ] Create comparison matrix:
  - [ ] Available API endpoints vs. Enabled tool actions
  - [ ] Identify overly restrictive limitations
  - [ ] Identify security concerns for missing endpoints

- [ ] Document recommendations:
  - [ ] Which endpoints should be added (with justification)
  - [ ] Which endpoints should remain restricted (with justification)
  - [ ] Priority levels for new endpoints (P0/P1/P2)

### 4. Implementation Plan

- [ ] Create tickets/issues for missing endpoints
- [ ] Prioritize based on:
  - [ ] Use case frequency
  - [ ] Security risk
  - [ ] Implementation complexity
  - [ ] User requests/feedback

## Resources

### OPNsense API Documentation
- OPNsense API Reference: https://docs.opnsense.org/development/api.html
- MCP OPNsense Server: Check for auto-discovery capabilities
- Current implementation: `src/tools/opnsense/readonly/` and `src/tools/opnsense/writes/`

### Proxmox API Documentation
- Proxmox API Reference: https://pve.proxmox.com/pve-docs/api-viewer/index.html
- Current implementation: `src/tools/proxmox/readonly/` and `src/tools/proxmox/writes/`
- Proxmox Client: `src/tools/proxmox/client.ts`

## Notes

- Focus on read-only operations first (lower risk)
- Write operations require careful security review
- Consider rate limiting and abuse prevention
- Document any endpoints that are intentionally restricted

