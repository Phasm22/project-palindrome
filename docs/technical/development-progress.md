# Development Progress Tracking

Machine-readable format for tracking high and medium priority development tasks.

## Status Legend
- `completed` - Implementation done, tested
- `in_progress` - Currently being worked on
- `pending` - Not started
- `blocked` - Blocked by dependency or issue

## High Priority Tasks

### 1. OPNsense SSH Fallback Optimization
- **Status**: `completed`
- **File**: `src/tools/opnsense/readonly/opnsense-readonly-tool.ts`
- **Change**: Parallelized SSH commands in `getFirewallRulesViaSSH` using `Promise.all()`
- **Expected Impact**: Reduce firewall rules query time from ~42s to ~10s
- **Test**: Run `bun run src/cli.ts opnsense firewall_rules_list` and verify duration

### 2. Permission Management - get_vm_ip
- **Status**: `completed`
- **File**: `src/tools/proxmox/readonly/proxmox-readonly-tool.ts`
- **Changes**:
  - Updated example description to mention guest agent requirement
  - Added note about VM.Monitor + VM.Audit permissions
- **Test**: Verify tool schema includes permission notes

### 3. Enhanced Metadata Enrichment
- **Status**: `completed`
- **Files**: 
  - `src/pce/types/index.ts` - Added fields to ChunkMetadata interface
  - `src/pce/vector/schema.ts` - Updated metadataToPayload and payloadToMetadata
- **Fields Added**: `agent_ID`, `time_series_window`, `document_version` (all optional)
- **Note**: Fields are optional and will be populated when chunking code is updated to provide them
- **Test**: Verify new fields appear in chunked documents (requires updating chunker to populate them)

### 4. Agent Reasoning Trace
- **Status**: `pending`
- **Files**:
  - `src/agent/runner.ts` - Capture reasoning steps
  - `src/pce/api/server.ts` - Expose via endpoint
- **Test**: Verify reasoning traces appear in dashboard

## Medium Priority Tasks

### 5. Cluster Status Implementation
- **Status**: `completed`
- **File**: `src/pce/api/server.ts`
- **Change**: Integrated ProxmoxClient and ProxmoxReadOnlyTool to fetch real cluster status
- **Features**: Fetches nodes, cluster status, and resources in parallel
- **Test**: Verify `/api/dashboard/cluster-status` returns real data

### 6. Vector Stats Implementation
- **Status**: `completed`
- **File**: `src/pce/api/server.ts`
- **Note**: Already implemented (lines 742-829)
- **Test**: Verify `/api/dashboard/vector-stats` returns collection stats

### 7. Topology.yaml Ingestion
- **Status**: `pending`
- **Files**:
  - Create `src/pce/edl/extraction/topology-extractor.ts`
  - Update `src/pce/edl/pipeline.ts` to handle yaml_config
- **Test**: Verify topology.yaml entities appear in graph

## Test Commands

```bash
# Test OPNsense SSH parallelization (via agent)
agent opnsense firewall_rules_list
# Expected: Uses ssh_execute, executes 4 commands in parallel, ~10s duration

# Test get_vm_ip permission notes (via agent)
agent proxmox get_vm_ip --node YANG --vmid 211
# Expected: 501 on guest agent (expected), fallback to config-based method succeeds

# Test cluster status
curl http://localhost:4000/api/dashboard/cluster-status
# Expected: Returns real Proxmox cluster data (nodes, VMs, quorum)

# Test vector stats
curl http://localhost:4000/api/dashboard/vector-stats
# Expected: Returns Qdrant collection statistics
```

## Test Results

### OPNsense Firewall Rules (2025-11-26)
- ✅ Agent correctly uses `opnsense_readonly firewall_rules_list` (updated)
- ✅ Tool uses SSH internally with approved pfctl commands (parallelized)
- ✅ Commands execute in parallel (4 commands: pfctl -sr, -sn, -si, -sa)
- ✅ Successfully retrieves firewall rules
- ⚠️ Fixed: Agent was trying direct ssh_execute with unapproved commands - now uses opnsense_readonly tool

### Proxmox get_vm_ip (2025-11-26)
- ✅ 501 error on guest agent endpoint (expected - guest agent not available)
- ✅ Fallback to config-based method works correctly
- ✅ Successfully retrieves VM IP address
- ✅ Permission notes in tool description are accurate
- ⚠️ Note: Parameter parsing issue on first attempt (YANG 211) - second attempt (proxBig 100) worked correctly

## Notes

- OPNsense SSH optimization: Changed from sequential `for` loop to `Promise.all()` for 4 commands
- Permission management: Added descriptive notes rather than schema-level flags (tool schema doesn't support requiresHigherPermissions field)
- Vector stats: Already implemented, no work needed
- Cluster status: Implemented with ProxmoxClient integration, fetches data in parallel for better performance

