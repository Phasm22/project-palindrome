# Phase 5: Exposure Graph & Attack Surface Analysis

## Overview

Phase 5 builds on Phase 4.5 (Firewall Rules) to create exposure mapping and attack surface analysis. This enables queries about VM exposure, attack paths, and security posture.

---

## Phase 5.1 — VM Exposure Mapping

### Goal

Build graph traversal chains that map:
```
VM → interface → subnet → firewall rules → exposure surface
```

Enable queries like:
- "Which VMs are exposed to the internet?"
- "What's the attack surface of VM X?"
- "Show all paths from WAN to VM Y"
- "Which VMs can reach each other?"

### Graph Chain Specification

**Exposure Path Query:**
```
VM (compute_vm)
  → has interface (NetworkInterface via vmId property)
    → connected to subnet (NetworkSubnet via CONNECTS_TO)
      → protected/allowed by rules (FirewallRule via ALLOWS/BLOCKS)
        → determine exposure level
```

**Key Relationships:**
- `(NetworkInterface).vmId = (ComputeVM).id` - VM's network interfaces (property-based)
- `(NetworkInterface)-[:CONNECTS_TO]->(NetworkSubnet)` - Interface subnet membership
- `(FirewallRule)-[:ALLOWS]->(NetworkSubnet)` - Rules allowing subnet access
- `(FirewallRule)-[:BLOCKS]->(NetworkSubnet)` - Rules blocking subnet access

### Implementation Tasks

1. **Extend TwinQueryService with Exposure Queries**
   - `vmExposure(vmId)` - Full exposure analysis for a VM
   - `vmsExposedToSubnet(subnetCidr)` - VMs reachable from a subnet
   - `exposurePath(fromSubnet, toVmId)` - Attack path from source to target
   - `internetExposedVms()` - VMs with WAN exposure

2. **Create Exposure Analysis Chains**
   - `analyzeVmExposureChain` - Detailed exposure report for a VM
   - `listExposedVmsChain` - List all exposed VMs
   - `attackPathChain` - Show attack path between two points

3. **Add Intent Detection**
   - Detect "exposed", "attack surface", "reachable", "internet access" queries
   - Route to exposure analysis chains

4. **Enhance Relationship Creation**
   - Ensure VM → Interface relationships exist
   - Link interfaces to subnets (already done in Phase 4)
   - Link rules to subnets (already done in Phase 4.5)

### Current Status

- ✅ Firewall rules ingested with relationships
- ✅ Subnets auto-created
- ✅ Rules linked to subnets via ALLOWS/BLOCKS
- ✅ VM → Interface relationships (via vmId property on NetworkInterface)
- ✅ Interface → Subnet relationships (CONNECTS_TO created by network parsers)
- ✅ Exposure query implementation (vmExposure, vmsExposedToSubnet, exposurePath, internetExposedVms)
- ✅ Exposure reasoning chains (analyzeVmExposureChain, listVmsExposedToSubnetChain, attackPathChain, listInternetExposedVmsChain)
- ✅ Exposure intent detection (detectExposureIntent)
- ✅ Agent runner integration
- ✅ VM-by-name search across all nodes (`find_vm_by_name` operation)
- ✅ Reasoning trace recording for all responses (including early returns from reasoning chains)
- ✅ Twin-first VM listings now default to QEMU-only, with container views still available via `vmKind`, and responses include traceable IDs + twin provenance
- ✅ Chat UI improvements (structured formatting, clickable trace IDs, better visual hierarchy)

### Implementation Summary

**New Files:**
- `src/reasoning/chains/exposure.ts` - Exposure analysis reasoning chains
- `src/reasoning/detectExposureIntent.ts` - Intent detection for exposure queries

**Extended Files:**
- `src/twin/api/twin-query-service.ts` - Added 4 new exposure query methods, `findVmByName` method, and vmKind-aware filters for all compute read paths
- `src/tools/TwinQueryTool.ts` - Added 4 new exposure operations, `find_vm_by_name` operation, plus support for `vmKind` parameter
- `src/agent/runner.ts` - Integrated exposure intent detection, routing, and reasoning trace recording for all responses
- `src/reasoning/chains/compute.ts` - Human-friendly twin summaries with trace IDs + provenance
- `src/reasoning/compute-intents.ts` - "List all VMs" now routes to the twin chain automatically
- `src/agent/system-prompt.ts` - Added `find_vm_by_name` example for VM name queries
- `dashboard/index.html` - Enhanced chat UI with structured formatting, clickable trace IDs, and improved visual hierarchy

**Query Operations:**
1. `exposure_vm_analysis` - Full exposure analysis for a specific VM
2. `exposure_vms_by_subnet` - Find VMs exposed to a subnet
3. `exposure_path` - Attack path from source subnet to target VM
4. `exposure_internet_exposed` - List all internet-exposed VMs
5. `find_vm_by_name` - Search for VMs by name across all nodes (case-insensitive partial match)

**Recent Improvements (Nov 2025):**
- Added `find_vm_by_name` operation to enable queries like "Is SentinelZero Running?" that search across all nodes
- Fixed reasoning trace recording - all agent responses (including early returns from reasoning chains) now record traces
- Enhanced chat UI with structured VM/node cards, clickable trace IDs, and better visual hierarchy
- Fixed `durationMs` undefined error in trace recording

---

## Phase 5.2 — Attack Path Analysis (Future)
### Goal

Build multi-hop path analysis:
- WAN → Firewall → Subnet → VM
- VM → VM lateral movement
- VPN → Internal network paths

---

## Phase 5.3 — Blast Radius & Risk Scoring (Future)

### Goal

- Calculate blast radius for compromised entities
- Risk scoring based on exposure level
- Criticality-based prioritization

