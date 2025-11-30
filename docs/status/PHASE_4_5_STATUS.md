# Phase 4.5: Firewall Rules as Canonical Entities - Implementation Status

## Overview

Phase 4.5 extends the digital twin with firewall rule entities and exposure graph relationships. This enables queries about network security posture, rule analysis, and VM exposure.

## Implementation Complete

✅ **Entity Schema**: `FirewallRule` entity with action, direction, interface, protocol, source, destination, chain  
✅ **Relationships**: `ALLOWS` and `BLOCKS` relationship types  
✅ **Parser**: `PfctlFirewallParser` parses `pfctl -sr` and `pfctl -sn` output  
✅ **TwinQueryService**: Firewall query operations (list, by chain, by subnet, exposure map)  
✅ **TwinQueryTool**: Firewall operations exposed to agent  
✅ **Reasoning Chains**: Firewall-specific reasoning chains  
✅ **Intent Detection**: `detectFirewallIntent` routes firewall queries  
✅ **Ingestion Pipeline**: `FirewallIngestionOrchestrator` ingests rules from OPNsense  

## Current Issue: Relationships Not Being Created

### Problem

Firewall ingestion reports **0 relationships** created:
```
[2025-11-27T05:26:41.045Z] [INFO] Firewall ingestion complete {"entities":101,"relationships":0}
```

This causes:
- Query "Which rules allow access to 172.16.0.0/22?" returns "None"
- Exposure map queries return empty results
- No connectivity between firewall rules and network subnets

---

# 🔥 Executive Summary — Why Relationships Aren't Created

## **Root Cause #1 — CIDR masks are being stripped before storage**

Even though the parser extracts `from 172.16.0.0/22`, by the time the rule reaches Neo4j: `"source": "172.16.0.0"` (no mask).

No mask → `isCidr()` → **false** → relationship logic never runs.

**This is the primary blocker.**

## **Root Cause #2 — No subnet entities in the twin**

Firewall logic links rules → subnets, but the subnets don't exist:
```
MATCH (n:TwinEntity { type: 'network_subnet' }) RETURN count(n) → 0
```

When subnets aren't present, `MERGE (rule)-[:ALLOWS]->(subnet)` does nothing because the `subnet` variable resolves to **null**.

Even if CIDRs were intact, **there is nothing to link to**.

## **Root Cause #3 — Relationship logic silently skips everything**

Because:
- CIDR invalid? → skip
- Subnet missing? → skip
- Destination "any" but no matching subnet entity? → skip

No warnings → ingestion reports `{ entities: 101, relationships: 0 }`.

Everything is "working," but **nothing is eligible** for linking.

### Root Cause Analysis

**1. Parser Extraction (FIXED)**
- ✅ Parser now correctly extracts: action, direction, interface, source, destination
- ✅ Handles pfctl format: "block drop in log on ! vtnet1 inet from IP-[REDACTED]/22 to any"
- ✅ Fixed token parsing order (direction before log, inet skip after interface)

**2. CIDR Mask Loss (ROOT CAUSE #1)**
- ❌ **CRITICAL**: Source stored as `"IP-[REDACTED]"` instead of `"IP-[REDACTED]/22"`
- Parser extracts `"IP-[REDACTED]/22"` correctly, but mask is lost during storage
- Neo4j query shows: `"source": "IP-[REDACTED]"` (no `/22` mask)
- Without mask, `isCidr()` returns false, so no relationships created
- **Fix needed**: Preserve CIDR mask when storing source/destination

**3. No Subnet Entities (ROOT CAUSE #2)**
- ❌ **CRITICAL**: Neo4j query returns **zero subnet entities**
- Network ingestion may not have run, or subnets weren't created
- Relationships target `network-subnet:172.16.0.0/22` but entity doesn't exist
- **Fix needed**: Ensure network ingestion runs first, or create subnets on-the-fly

**4. Relationship Creation Logic (WORKING BUT BLOCKED)**
- ✅ Logic correctly checks source CIDRs when destination is "any"
- ✅ Handles both pass and block rules
- ❌ **Blocked by**: Missing CIDR masks and missing subnet entities

### Why Fixes Aren't Working

1. **Parser fixes work** ✅ - Fields extracted correctly (verified)
2. **Relationship logic works** ✅ - But never executes because:
   - Source stored as `"IP-[REDACTED]"` (no mask) → `isCidr()` returns false
   - Even if CIDR matched, target subnet entities don't exist in graph
3. **Primary blocker**: CIDR mask lost during entity storage
4. **Secondary blocker**: No subnet entities exist to link to

### Required Fixes

1. **Preserve CIDR mask in source/destination fields** (CRITICAL)
   - Issue: Parser extracts `"IP-[REDACTED]/22"` but stored as `"IP-[REDACTED]`
   - Fix: Ensure `entity.data.source` and `entity.data.destination` preserve full CIDR
   - Check: `buildEntityProperties()` in `twin-updater.ts` may be truncating
   - Check: Entity schema validation may be stripping mask

2. **Ensure subnets exist before creating relationships** (CRITICAL)
   - Current: Zero subnet entities in graph
   - Option A: Run `bun pce:ingest-network` before firewall ingestion
   - Option B: Create subnet entities on-the-fly during firewall ingestion
   - Option C: Make relationship creation idempotent (create subnet if missing)

3. **Improve CIDR matching for redacted IPs**
   - Current: `isCidr("IP-[REDACTED]")` returns false (no mask)
   - Fix: Update `isCidr()` to handle redacted format OR normalize during parsing
   - Alternative: Extract mask separately and match against known subnets

4. **Add relationship creation logging** (DEBUGGING)
   - Log when relationships are skipped (subnet missing, CIDR invalid, etc.)
   - Log successful relationship creation for debugging
   - Log source/destination values to verify CIDR format

### Test Cases

```bash
# 1. Verify parser extracts fields (WORKS)
bun -e "const p = require('./src/parsers/security/pfctl-firewall-parser.ts'); ..."
# Result: ✅ Parser extracts "IP-[REDACTED]/22" correctly

# 2. Check stored source/destination in Neo4j (FAILS)
MATCH (r:TwinEntity {type: 'firewall_rule'}) 
RETURN r.id, r.source, r.destination LIMIT 5
# Result: ❌ source = "IP-[REDACTED]" (mask lost)

# 3. Check if subnets exist (FAILS)
MATCH (s:TwinEntity {type: 'network_subnet'}) RETURN count(s)
# Result: ❌ Zero subnets exist

# 4. Check if relationships exist (FAILS)
MATCH (r:TwinEntity {type: 'firewall_rule'})-[rel:ALLOWS|BLOCKS]->(s:TwinEntity) 
RETURN count(rel)
# Result: ❌ Zero relationships (expected, given above issues)

# 5. Test query (FAILS)
agent ask "Which rules allow access to 172.16.0.0/22?"
# Result: ❌ Returns "None" (no relationships to query)
```

### Next Steps

1. ✅ **FIXED**: Improved CIDR matching to handle redacted IPs
2. ✅ **FIXED**: Added debug logging to relationship creation
3. ✅ **FIXED**: Added relationship existence checks (skip if nodes don't exist)
4. ✅ **FIXED**: Auto-create subnet entities during firewall ingestion if missing
5. ⏳ **PENDING**: Verify CIDR mask preservation in Neo4j storage
6. ⏳ **PENDING**: Test full ingestion pipeline with fixes

### Implementation Status

**Fix 1 - CIDR Preservation**: ✅ Parser extracts correctly, need to verify storage  
**Fix 2 - Subnet Entities**: ✅ Auto-create implemented (`ensureSubnetEntities()`)  
**Fix 3 - CIDR Matching**: ✅ Improved `isCidr()` to handle redacted IPs  
**Fix 4 - Debug Logging**: ✅ Added comprehensive logging throughout pipeline  
**Fix 5 - Relationship Validation**: ✅ Added existence checks before creating relationships

---

## ✅ Fixes Implemented

### 1. Improved CIDR Matching
- Updated `isCidr()` to handle `"IP-[REDACTED]/22"` format
- Pattern: `/\/\d+$/` matches any string ending with `/mask`
- Handles IPv4, IPv6, and redacted IP formats

### 2. Auto-Create Subnet Entities
- `ensureSubnetEntities()` method creates subnet entities on-the-fly
- Extracts CIDRs from rule source/destination fields
- Creates `NetworkSubnet` entities with proper schema
- Uses Neo4j MERGE for idempotency

### 3. Comprehensive Debug Logging
- Logs CIDR validation failures with actual values
- Logs relationship creation counts
- Warns when relationships skipped (missing entities, invalid CIDR)
- Debug logs sample parsed entities to verify CIDR preservation

### 4. Relationship Existence Validation
- `writeRelationships()` checks if source/target entities exist
- Skips relationships if nodes don't exist (with warning)
- Prevents silent failures

### 5. Enhanced Relationship Creation Logic
- Creates relationships for source CIDRs when destination is "any"
- Handles both pass (ALLOWS) and block/reject (BLOCKS) rules
- Logs detailed skip reasons for debugging

---

## 🧪 Testing Required

After fixes, verify:

1. **CIDR Preservation**: Check Neo4j storage
   ```cypher
   MATCH (r:TwinEntity {type:'firewall_rule'}) 
   RETURN r.source, r.destination LIMIT 5
   ```
   Expected: Values include `/mask` (e.g., `"IP-[REDACTED]/22"`)

2. **Subnet Creation**: Check if subnets are created
   ```cypher
   MATCH (s:TwinEntity {type:'network_subnet'}) 
   RETURN s.id, s.displayName LIMIT 10
   ```
   Expected: Subnets exist for CIDRs referenced in rules

3. **Relationships Created**: Check relationship count
   ```cypher
   MATCH (r:TwinEntity {type:'firewall_rule'})-[rel:ALLOWS|BLOCKS]->(s:TwinEntity)
   RETURN count(rel)
   ```
   Expected: > 0 relationships

4. **Query Works**: Test agent query
   ```bash
   agent ask "Which rules allow access to 172.16.0.0/22?"
   ```
   Expected: Returns matching rules

## Files Modified

- `src/twin/models/entities.ts` - Added FirewallRule schema
- `src/twin/models/relationships.ts` - Added ALLOWS/BLOCKS relationships
- `src/parsers/security/pfctl-firewall-parser.ts` - Parser implementation
- `src/twin/api/twin-query-service.ts` - Firewall query operations
- `src/tools/TwinQueryTool.ts` - Firewall tool operations
- `src/reasoning/chains/firewall.ts` - Firewall reasoning chains
- `src/reasoning/detectFirewallIntent.ts` - Intent detection
- `src/pce/ingestion/firewall-ingestion.ts` - Ingestion orchestrator
- `src/agent/runner.ts` - Integrated firewall intent routing

