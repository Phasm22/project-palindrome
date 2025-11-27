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
- ✅ Exposure query implementation (vmExposure, vmsExposedToSubnet, exposurePath, internetExposedVms)
- ✅ Exposure reasoning chains (analyzeVmExposureChain, listVmsExposedToSubnetChain, attackPathChain, listInternetExposedVmsChain)
- ✅ Exposure intent detection (detectExposureIntent)
- ✅ Agent runner integration
- ✅ End-to-end testing (queries work, need interface→subnet relationships for full exposure analysis)
- ✅ Twin-first VM listings now default to QEMU-only, with container views still available via `vmKind`, and responses include traceable IDs + twin provenance

### Implementation Summary

**New Files:**
- `src/reasoning/chains/exposure.ts` - Exposure analysis reasoning chains
- `src/reasoning/detectExposureIntent.ts` - Intent detection for exposure queries

**Extended Files:**
- `src/twin/api/twin-query-service.ts` - Added 4 new exposure query methods and vmKind-aware filters for all compute read paths
- `src/tools/TwinQueryTool.ts` - Added 4 new exposure operations plus support for `vmKind` parameter
- `src/agent/runner.ts` - Integrated exposure intent detection and routing
- `src/reasoning/chains/compute.ts` - Human-friendly twin summaries with trace IDs + provenance
- `src/reasoning/compute-intents.ts` - "List all VMs" now routes to the twin chain automatically

**Query Operations:**
1. `exposure_vm_analysis` - Full exposure analysis for a specific VM
2. `exposure_vms_by_subnet` - Find VMs exposed to a subnet
3. `exposure_path` - Attack path from source subnet to target VM
4. `exposure_internet_exposed` - List all internet-exposed VMs

**Note:** For full exposure analysis, ensure network ingestion creates `CONNECTS_TO` relationships between interfaces and subnets. The queries are ready and will work once those relationships exist.

---

## Phase 5.2 — Attack Path Analysis (Future)
   P
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

