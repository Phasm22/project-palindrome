# Digital Twin Data Audit

## Purpose
Review what data is being tracked in the digital twin to identify:
1. Redundant fields (data stored both in `dataJson` and as denormalized properties)
2. Temporary/cached data that shouldn't be persisted
3. Fields that could be computed on-the-fly instead of stored

## Current Storage Pattern

### Entity Storage Structure
Each entity in Neo4j has:
- **Core fields**: `id`, `type`, `displayName`, `source`, `collectedAt`
- **Canonical data**: `dataJson` (full JSON of entity.data)
- **Denormalized fields**: Extracted from `dataJson` for query performance

### Denormalized Fields by Entity Type

#### Compute Nodes
- `status` - Also in dataJson
- `nodeName` - Duplicate of `displayName`
- `normalizedNodeName` - Computed from `displayName`

#### Compute VMs
- `state` - Also in dataJson
- `agentAvailable` - Also in dataJson
- `nodeId` - Also in dataJson
- `nodeName` - Derived from `nodeId`
- `normalizedNodeName` - Computed from `nodeName`
- `vmKind` - Also in dataJson

#### Network Interfaces
- `status` - Also in dataJson
- `nodeName` - Also in dataJson
- `normalizedNodeName` - Computed from `nodeName`
- `vmId` - Also in dataJson
- `primaryIp` - Also in dataJson
- `ips` - Also in dataJson (as array)

#### Network Subnets
- `cidr` - Also in dataJson
- `gateway` - Also in dataJson

#### Firewall Rules
- `action` - Also in dataJson
- `direction` - Also in dataJson
- `interface` - Also in dataJson
- `protocol` - Also in dataJson
- `source` - Also in dataJson
- `destination` - Also in dataJson
- `chain` - Also in dataJson
- `ruleType` - Also in dataJson

#### Storage (New)
- No denormalized fields yet (all in dataJson)

## Analysis

### Redundant Fields
All denormalized fields are **intentionally redundant** with `dataJson` for performance:
- **Purpose**: Neo4j can index and query these fields directly without JSON parsing
- **Trade-off**: Storage space vs query performance
- **Recommendation**: Keep denormalized fields for frequently-queried properties

### Computed Fields
- `normalizedName` - Computed from `displayName.toLowerCase()`
- `normalizedNodeName` - Computed from `nodeName.toLowerCase()`
- **Recommendation**: These are useful for case-insensitive queries. Could be computed on-the-fly, but storing them improves query performance.

### Potential Issues

1. **Duplicate `nodeName` for Compute Nodes**
   - `nodeName` = `displayName` (exact duplicate)
   - **Recommendation**: Could remove `nodeName` and always use `displayName` for nodes

2. **Derived `nodeName` for VMs**
   - Extracted from `nodeId` by splitting on `:`
   - **Recommendation**: Keep for query convenience, but ensure `nodeId` format is stable

3. **Array field `ips`**
   - Stored as Neo4j array property
   - Also in `dataJson` as array
   - **Recommendation**: Keep for query performance (can query `WHERE '192.168.1.1' IN n.ips`)

## Recommendations

### Keep (Performance Benefits)
- ✅ All denormalized fields - Improve query performance
- ✅ `normalizedName` / `normalizedNodeName` - Enable case-insensitive queries
- ✅ `dataJson` - Canonical source of truth

### Consider Removing
- ⚠️ `nodeName` for Compute Nodes (duplicate of `displayName`)
  - **Impact**: Low - queries can use `displayName` instead
  - **Benefit**: Reduces storage and maintenance

### No Temporary/Cache Data Found
- ✅ No processing flags or temporary state
- ✅ No cache keys or hashes
- ✅ All fields serve a purpose (either canonical data or query optimization)

## Conclusion

The current data model is **well-designed**:
- Denormalized fields provide query performance benefits
- No temporary or cached data is being persisted
- All redundancy is intentional for performance
- `collectedAt` timestamps enable stale detection

**No changes needed** - the current approach balances storage efficiency with query performance appropriately.
