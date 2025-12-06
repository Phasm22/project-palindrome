# Ingestion Strategy & Automation

## Current State

### Manual Ingestion
- **Status**: ✅ Implemented, but **manual only**
- **Scripts**:
  - `bun run scripts/ingest-all.ts` - Full ingestion (Proxmox + Network + Firewall)
  - `bun run scripts/ingest-proxmox.ts` - Proxmox only
  - `bun run scripts/ingest-network.ts` - Network interfaces only
  - `bun run scripts/ingest-firewall.ts` - Firewall rules only

### What Keeps State Up to Date

1. **TwinSync (Action-triggered)**
   - ✅ **Automatic** after VM creation/destruction
   - When you create a VM via `compute.create_vm`, `TwinSync.syncTerraformVms()` runs automatically
   - Syncs the new VM to the digital twin immediately
   - **Location**: `src/actions/helpers/twin-sync.ts`

2. **On-demand Tool Calls**
   - ✅ **Automatic** when agent queries
   - When you ask "what VMs are on YANG?", the agent uses `proxmox_readonly` which fetches **fresh data** from Proxmox API
   - The twin is queried first, but if data is stale, tools fetch fresh data
   - **Note**: Fresh tool data doesn't update the twin - it's just for that query

3. **Manual Ingestion**
   - ⚠️ **Manual** - you must run `bun run scripts/ingest-all.ts`
   - Updates both vector store (for RAG) and graph store (digital twin)
   - **When to run**: After significant infrastructure changes, or periodically

## The Gap: No Scheduled Ingestion

**Problem**: The digital twin can become stale between manual ingestion runs.

**Example Scenario**:
1. You create VM "bob" via action → TwinSync updates twin ✅
2. Someone manually creates VM "alice" in Proxmox UI → Twin doesn't know about it ❌
3. You ask "list all VMs" → Agent queries twin, doesn't see "alice" ❌
4. Agent uses `proxmox_readonly` → Finds "alice" ✅ (but twin still stale)

## Recommended Solution: Scheduled Ingestion Job

### Option 1: Cron Job (Simple)
```bash
# Add to crontab (crontab -e)
# Run full ingestion every 5 minutes
*/5 * * * * cd /home/tj/project-palindrome && bun run scripts/ingest-all.ts >> /var/log/palindrome-ingestion.log 2>&1
```

### Option 2: Built-in Scheduler (Better)
Create a scheduler service that runs in the background:

**File**: `src/pce/scheduler/ingestion-scheduler.ts`
```typescript
import { NetworkIngestionOrchestrator } from "../ingestion/network-ingestion";
import { FirewallIngestionOrchestrator } from "../ingestion/firewall-ingestion";
import { ProxmoxIngestionOrchestrator } from "../ingestion/proxmox-ingestion";

export class IngestionScheduler {
  private intervals: Map<string, NodeJS.Timeout> = new Map();

  start() {
    // Proxmox: every 2-5 minutes (as per docs/Parser_Layer.md)
    this.intervals.set('proxmox', setInterval(async () => {
      await this.runProxmoxIngestion();
    }, 3 * 60 * 1000)); // 3 minutes

    // Network: every 1-5 minutes
    this.intervals.set('network', setInterval(async () => {
      await this.runNetworkIngestion();
    }, 2 * 60 * 1000)); // 2 minutes

    // Firewall: every 5-10 minutes (less frequent)
    this.intervals.set('firewall', setInterval(async () => {
      await this.runFirewallIngestion();
    }, 7 * 60 * 1000)); // 7 minutes
  }

  stop() {
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
  }
}
```

**Integration**: Start scheduler when API server starts:
```typescript
// src/pce/api/server.ts
import { IngestionScheduler } from "../scheduler/ingestion-scheduler";

const scheduler = new IngestionScheduler();
scheduler.start();
```

### Option 3: Event-Triggered (Future)
- Webhooks from Proxmox/OPNsense when changes occur
- Already have webhook infrastructure (`src/pce/realtime/webhook-listener.ts`)
- Would need to configure Proxmox/OPNsense to send webhooks

## Recommended Schedule (from docs/Parser_Layer.md)

| Domain | Frequency | Reason |
|--------|-----------|--------|
| **Proxmox** | Every 2-5 minutes | VMs can be created/destroyed frequently |
| **Network Interfaces** | Every 1-5 minutes | IPs, routes change more often |
| **Firewall Rules** | Every 5-10 minutes | Rules change less frequently |
| **Storage** | Every 10-15 minutes | Storage changes slowly |

## When to Run Manual Ingestion

Run `bun run scripts/ingest-all.ts` when:
- ✅ **Initial setup** - First time setting up the system
- ✅ **After bulk changes** - If you manually created/deleted many VMs
- ✅ **After infrastructure changes** - Network reconfiguration, firewall rule changes
- ✅ **Troubleshooting** - If twin seems out of sync

**You don't need to run it**:
- ❌ After every VM creation (TwinSync handles this)
- ❌ Before every query (agent tools fetch fresh data)

## Summary

**Current**: Manual ingestion only, TwinSync handles action-triggered updates

**Recommended**: Add scheduled ingestion job (Option 1 or 2) to keep twin fresh automatically

**Future**: Event-triggered ingestion via webhooks for real-time updates

