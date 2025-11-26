# API Discovery Action Plan

## Current Status

### Proxmox Discovery Results
- **19 endpoints discovered**
- **17 actions enabled in tool**
- **9 discovered endpoints not enabled** (potential additions)
- **8 enabled actions not discovered** (need investigation)

### OPNsense Discovery Results
- **5 endpoints discovered**
- **20 actions enabled in tool**
- **16 enabled actions not discovered** (significant gap)

---

## Option 1: Add Discovered Endpoints to Tools ⭐ RECOMMENDED

### High-Value Additions

#### Node-Level Endpoints
- ✅ **`node_storage`** (`/nodes/{node}/storage`) - List storage on a node
- ✅ **`node_services`** (`/nodes/{node}/services`) - List services on a node
- ✅ **`node_tasks`** (`/nodes/{node}/tasks`) - List tasks on a node

#### System Endpoints
- ✅ **`get_version`** (`/version`) - Get Proxmox version (useful for compatibility checks)

#### Storage Endpoints
- ⚠️ **`get_storage`** (`/storage`) - Global storage list (may require global permissions)

#### Access Management Endpoints
- ⚠️ **`get_users`** (`/access/users`) - List users (sensitive, consider ACL restrictions)
- ⚠️ **`get_roles`** (`/access/roles`) - List roles (sensitive, consider ACL restrictions)
- ⚠️ **`get_permissions`** (`/access/permissions`) - List permissions (sensitive, consider ACL restrictions)

#### VM Agent Endpoints
- ⚠️ **`get_vm_agent`** (`/nodes/{node}/qemu/{vmid}/agent/info`) - Requires guest agent (already marked with `requiresHigherPermissions`)

### Implementation Steps

1. **Update `ProxmoxReadOnlyParams` enum** in `src/tools/proxmox/readonly/proxmox-readonly-tool.ts`:
   ```typescript
   action: z.enum([
     // ... existing actions ...
     "node_storage",
     "node_services", 
     "node_tasks",
     "get_version",
     // ... optionally add access endpoints with proper ACL restrictions ...
   ])
   ```

2. **Implement handlers** in `ProxmoxReadOnlyTool.execute()` method

3. **Add examples** to tool schema

4. **Test each endpoint** to ensure proper error handling

---

## Option 2: Remove Non-Existent Actions

### Actions to Remove/Deprecate

- ❌ **`node_resources`** - Endpoint returns 501 "not implemented"
  - **Action**: Remove from enum or mark as deprecated
  - **Note**: This was likely a Proxmox API version difference

### Implementation Steps

1. Remove `node_resources` from `ProxmoxReadOnlyParams` enum
2. Update any code that references this action
3. Add deprecation notice if keeping for backward compatibility

---

## Option 3: Fix Permission-Restricted Actions

### Actions Requiring Higher Permissions

- ⚠️ **`get_vm_ip`** - Returns 403 (requires guest agent)
  - **Current Status**: Endpoint discovered but returns 403
  - **Options**:
    - Keep in tool but document requirements clearly
    - Add `requiresHigherPermissions: true` metadata
    - Provide better error messages explaining guest agent requirement

- ⚠️ **`get_lxc_config`** - Not discovered (no LXC containers to probe)
  - **Current Status**: Action exists but no containers found to test
  - **Options**:
    - Keep action (will work when LXC containers exist)
    - Add discovery logic that doesn't require existing containers

### Implementation Steps

1. **Mark permission-restricted actions** in tool schema:
   ```typescript
   {
     action: "get_vm_ip",
     description: "Get VM IP via guest agent (requires guest agent enabled and running)",
     requiresHigherPermissions: true
   }
   ```

2. **Improve error handling** to provide clear messages about requirements

3. **Update discovery** to mark these endpoints even when they return 403

---

## Option 4: Handle Cluster vs Standalone Differences

### Cluster-Only Actions (Not Available on Standalone Nodes)

- `cluster_resources`
- `cluster_status`
- `cluster_ceph_status`
- `ha_groups`
- `ha_resources`

### Current Status
- These actions are enabled but not discovered because `proxBig` is a standalone node
- They will work on cluster nodes (yin/yang)

### Options

1. **Keep as-is** - Actions work on cluster nodes, just not discovered on standalone
2. **Add conditional discovery** - Detect cluster membership and discover accordingly
3. **Document limitations** - Add notes about cluster vs standalone availability

### Implementation Steps

1. Update discovery to properly detect cluster membership
2. Add metadata to actions indicating cluster-only availability
3. Update tool documentation with cluster vs standalone notes

---

## Option 5: Expand OPNsense Discovery

### Current Gap
- **5 endpoints discovered** vs **20 actions enabled**
- **16 actions not discovered** - significant gap

### Potential Issues
- OPNsense API is more fragmented/module-based
- May require different discovery approach
- Some endpoints may require specific modules enabled

### Implementation Steps

1. Review OPNsense discovery patterns
2. Check if more endpoints can be discovered via module enumeration
3. Consider manual endpoint list for OPNsense if discovery is too complex

---

## Recommended Action Plan

### Phase 1: Quick Wins (Low Risk)
1. ✅ Add `node_storage`, `node_services`, `node_tasks` to Proxmox tool
2. ✅ Add `get_version` to Proxmox tool
3. ❌ Remove `node_resources` from Proxmox tool (doesn't exist)

### Phase 2: Permission Management (Medium Risk)
1. ⚠️ Mark `get_vm_ip` with `requiresHigherPermissions: true`
2. ⚠️ Improve error messages for permission-restricted endpoints
3. ⚠️ Consider adding access management endpoints with strict ACL restrictions

### Phase 3: Cluster Support (Low Priority)
1. Document cluster vs standalone differences
2. Improve cluster endpoint discovery
3. Add metadata to cluster-only actions

### Phase 4: OPNsense Expansion (Future)
1. Investigate OPNsense discovery gaps
2. Consider alternative discovery methods for OPNsense
3. Evaluate if manual endpoint list is needed

---

## Automation Opportunities

### Option A: Auto-Generate Tool Schemas from Discovery
- Use discovery results to automatically update tool action enums
- Generate handler stubs from discovered endpoints
- Maintain sync between discovery and tool implementation

### Option B: Runtime Endpoint Validation
- Validate tool actions against discovered endpoints at runtime
- Warn when using actions that don't exist
- Provide suggestions for alternative endpoints

### Option C: Continuous Discovery
- Run discovery as part of CI/CD pipeline
- Alert when new endpoints are discovered
- Auto-generate PRs for new endpoint additions

---

## Decision Matrix

| Action | Value | Effort | Risk | Priority |
|--------|-------|--------|------|----------|
| Add node_storage/services/tasks | High | Low | Low | ⭐⭐⭐ |
| Add get_version | Medium | Low | Low | ⭐⭐ |
| Remove node_resources | Medium | Low | Low | ⭐⭐ |
| Mark get_vm_ip permissions | Medium | Low | Low | ⭐⭐ |
| Add access endpoints | High | Medium | High | ⭐ |
| Fix cluster discovery | Low | Medium | Low | ⭐ |
| Expand OPNsense discovery | High | High | Medium | ⭐ |

---

## Next Steps

1. **Review this plan** and prioritize actions
2. **Start with Phase 1** (quick wins)
3. **Test each addition** thoroughly
4. **Update documentation** as you go
5. **Consider automation** for future maintenance

