# Stale Node Cleanup Implementation

## Problem

Nodes in the digital twin can become stale when:
- VMs are deleted from Proxmox but remain in the twin
- Network interfaces are removed but not cleaned up
- Firewall rules are changed but old rules remain
- Nodes are removed from clusters but still tracked

## Solution

A comprehensive stale node cleanup system that:
1. **Tracks last seen timestamps** - Uses `collectedAt` field as `lastSeen` indicator
2. **Verifies against source systems** - Checks Proxmox/OPNsense to confirm entities exist
3. **Automatic cleanup** - Runs after each scheduled ingestion (every 5 minutes)
4. **Multiple entity types** - Supports VMs, nodes, interfaces, subnets, firewall rules

## Implementation

### Core Components

#### 1. StaleNodeCleaner (`src/twin/cleanup/stale-node-cleaner.ts`)

Main cleanup service with methods for each entity type:

- `cleanStaleVms()` - Verifies VMs exist in Proxmox
- `cleanStaleNodes()` - Verifies compute nodes exist in Proxmox
- `cleanStaleInterfaces()` - Uses lastSeen-based cleanup
- `cleanStaleSubnets()` - Removes subnets with no connected interfaces
- `cleanStaleFirewallRules()` - Uses lastSeen-based cleanup
- `cleanStaleByLastSeen()` - Removes entities not seen in threshold period (default: 10 minutes)

#### 2. Integration with Ingestion Scheduler

The `IngestionScheduler` now automatically runs cleanup after each ingestion cycle:

```typescript
// After Proxmox, Network, and Firewall ingestion complete
const cleaner = new StaleNodeCleaner();
const cleanupResults = await cleaner.cleanAll({ maxAgeMinutes: 10 });
```

#### 3. Standalone Script

Manual cleanup script: `scripts/clean-stale-nodes.ts`

```bash
# Dry run (see what would be deleted)
bun run scripts/clean-stale-nodes.ts --dry-run

# Actual cleanup
bun run scripts/clean-stale-nodes.ts

# Custom threshold (30 minutes)
bun run scripts/clean-stale-nodes.ts --max-age=30
```

## How It Works

### 1. Source Verification (VMs, Nodes)

For entities that can be verified against source systems:

1. Query all entities of type from Neo4j
2. Fetch current state from Proxmox API
3. Compare and identify missing entities
4. Delete stale entities from Neo4j

### 2. LastSeen-Based Cleanup (Interfaces, Firewall Rules)

For entities harder to verify directly:

1. Query entities with `collectedAt < (now - threshold)`
2. Remove entities not seen in threshold period
3. Default threshold: 10 minutes (2x ingestion interval)

### 3. Relationship-Based Cleanup (Subnets)

For entities that should have relationships:

1. Find subnets with no connected interfaces
2. Remove orphaned subnets

## Configuration

### Environment Variables

- `PROXMOX_URL` - Proxmox API URL
- `PROXMOX_TOKEN_ID` - API token ID
- `PROXMOX_TOKEN_SECRET` - API token secret (or node-specific: `YIN_TOKEN_SECRET`, etc.)

### Thresholds

- **Default max age**: 10 minutes (2x ingestion interval)
- **Configurable**: Pass `maxAgeMinutes` to `StaleNodeCleaner` constructor

## Usage

### Automatic (Recommended)

Cleanup runs automatically after each scheduled ingestion (every 5 minutes). No action needed.

### Manual

```bash
# Test what would be cleaned
bun run scripts/clean-stale-nodes.ts --dry-run

# Clean stale nodes
bun run scripts/clean-stale-nodes.ts

# Custom age threshold
bun run scripts/clean-stale-nodes.ts --max-age=30
```

### Programmatic

```typescript
import { StaleNodeCleaner } from "./src/twin/cleanup/stale-node-cleaner";

const cleaner = new StaleNodeCleaner(undefined, { maxAgeMinutes: 15 });
const results = await cleaner.cleanAll({ dryRun: false });

for (const result of results) {
  console.log(`${result.entityType}: ${result.deleted} deleted`);
}
```

## Metrics

The cleanup process records metrics:

- `ingestion_scheduler_cleanup_deleted` - Total nodes deleted
- `ingestion_scheduler_cleanup_duration_ms` - Cleanup duration

## Safety Features

1. **Dry run mode** - Test without deleting
2. **Error handling** - Continues even if one entity type fails
3. **Logging** - Detailed logs of what's deleted
4. **Metrics** - Track cleanup performance

## Entity Types Supported

- ✅ `compute_vm` - VMs verified against Proxmox
- ✅ `compute_node` - Nodes verified against Proxmox
- ✅ `network_interface` - Cleaned by lastSeen
- ✅ `network_subnet` - Cleaned if no interfaces
- ✅ `firewall_rule` - Cleaned by lastSeen

## Future Enhancements

1. **Storage entities** - Add PVE_STORAGE cleanup
2. **OPNsense verification** - Direct verification of firewall rules
3. **Configurable thresholds** - Per-entity-type thresholds
4. **Soft delete** - Mark as stale instead of deleting immediately

## Troubleshooting

### Cleanup not running

Check ingestion scheduler logs:
```bash
# Check if scheduler is running
curl http://localhost:4000/api/dashboard/execution-stats | jq '.ingestion'

# Check logs
tail -f logs/palindrome-api.log | grep cleanup
```

### Too many deletions

Increase threshold:
```typescript
const cleaner = new StaleNodeCleaner(undefined, { maxAgeMinutes: 30 });
```

### Missing entities after cleanup

Check if entities are actually stale:
```bash
bun run scripts/clean-stale-nodes.ts --dry-run
```

## Related Files

- `src/twin/cleanup/stale-node-cleaner.ts` - Main cleanup service
- `src/pce/scheduler/ingestion-scheduler.ts` - Scheduler integration
- `scripts/clean-stale-nodes.ts` - Standalone script
- `src/twin/state/twin-updater.ts` - Entity upsert (uses `collectedAt` as lastSeen)
