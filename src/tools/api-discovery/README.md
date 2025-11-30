# API Discovery System

Automated discovery and ingestion of API capabilities for tools. Replaces manual endpoint tracking with runtime discovery and automatic schema generation.

## Problem

Manually tracking API endpoints doesn't scale:
- **2 tools** = hundreds of endpoints to document
- APIs change frequently
- Valuable context gets lost
- No correlation between available APIs and enabled actions

## Solution

Automated discovery system that:
1. **Probes APIs** at runtime to discover available endpoints
2. **Generates schemas** automatically from discoveries
3. **Identifies gaps** between discovered and enabled endpoints
4. **Scales** to any number of tools

## Architecture

```
┌─────────────────────────────────────┐
│   Discovery Framework (Base)        │
│   - Endpoint probing                │
│   - Schema generation               │
│   - Gap analysis                   │
└──────────────┬──────────────────────┘
               │
       ┌───────┴────────┐
       │                │
┌──────▼──────┐  ┌──────▼──────┐
│  Proxmox   │  │  OPNsense   │
│  Discovery │  │  Discovery   │
└────────────┘  └──────────────┘
```

## Usage

### Basic Discovery

```typescript
import { discoveryRegistry } from "./api-discovery";
import { ProxmoxDiscoveryService } from "./proxmox-discovery";
import { ProxmoxClient } from "../proxmox/client";

// Setup
const proxmoxClient = new ProxmoxClient({
  url: process.env.PROXMOX_URL!,
  tokenId: process.env.PROXMOX_TOKEN_ID!,
  tokenSecret: process.env.PROXMOX_TOKEN_SECRET!,
});

// Register discovery service
discoveryRegistry.register(
  new ProxmoxDiscoveryService(proxmoxClient, process.env.PROXMOX_URL!)
);

// Discover all endpoints
const results = await discoveryRegistry.discoverAll();
```

### Running Discovery Script

```bash
# Discover all services
bun run scripts/discover-api-endpoints.ts --service=all

# Discover specific service
bun run scripts/discover-api-endpoints.ts --service=proxmox
bun run scripts/discover-api-endpoints.ts --service=opnsense
```

### Output

Discovery results are saved to:
- `docs/technical/api-discovery-results/discovery-{timestamp}.json`
- `docs/technical/api-discovery-results/gap-analysis-{timestamp}.json`

## How Discovery Works

### Proxmox Discovery

1. **Pattern Probing**: Tests common endpoint patterns
2. **Cluster Resources**: Discovers endpoints via cluster resource types
3. **Node Introspection**: Probes node-specific endpoints
4. **Response Analysis**: Infers schemas from API responses

### OPNsense Discovery

1. **Module Structure**: Discovers endpoints via module organization
2. **Pattern Matching**: Tests common API patterns
3. **MCP Integration**: Uses MCP server discovery (if available)
4. **Response Schema**: Infers schemas from responses

## Gap Analysis

The system automatically compares:
- **Discovered endpoints** (what the API offers)
- **Enabled actions** (what tools expose)

And identifies:
- Missing endpoints (discovered but not enabled)
- Enabled but not discovered (may require parameters)

## Extending

### Adding a New Discovery Service

```typescript
import { ApiDiscoveryService, DiscoveryResult } from "./discovery-framework";

export class MyServiceDiscovery extends ApiDiscoveryService {
  serviceName = "my-service";
  baseUrl: string;

  constructor(baseUrl: string) {
    super();
    this.baseUrl = baseUrl;
  }

  async discoverEndpoints(): Promise<DiscoveryResult> {
    // Implement discovery logic
    return {
      service: this.serviceName,
      baseUrl: this.baseUrl,
      endpoints: [...],
      discoveredAt: new Date().toISOString(),
    };
  }

  async probeEndpoint(endpoint: DiscoveredEndpoint): Promise<{
    accessible: boolean;
    responseSchema?: any;
    error?: string;
  }> {
    // Implement endpoint probing
  }
}
```

## Benefits

✅ **Scalable**: Works for 2 tools or 200 tools  
✅ **Automatic**: No manual documentation needed  
✅ **Accurate**: Discovers actual available endpoints  
✅ **Maintainable**: Auto-updates when APIs change  
✅ **Comprehensive**: Finds endpoints you didn't know existed  

## Future Enhancements

- [ ] OpenAPI/Swagger spec integration
- [ ] MCP server tool definition discovery
- [ ] Periodic re-discovery (cron job)
- [ ] Auto-generate tool code from discoveries
- [ ] Security classification of endpoints
- [ ] Rate limit detection

