# Issue Validation Report

## ✅ **VALIDATED ISSUES** (Confirmed in Codebase)

### **1. Proxmox Tooling Issues**

#### **(A) Node Name Mismatches → 403s** ✅ **FIXED**

**Status:** Node normalization implemented with fallback support

**Evidence:**
- ✅ `normalizeNodeName()` exists in both `proxmox-readonly-tool.ts` (line 393) and `proxmox-write-tool.ts` (line 199)
- ✅ `NODE_ALIASES` map exists with `prox_big -> proxBig` mapping (lines 179-185)
- ✅ Fuzzy matching implemented (ignores underscores/hyphens/case)
- ✅ Normalization called in all node-specific code paths
- ✅ **Fixed:** `list_vms` now falls back to `cluster_resources` when node-specific call fails (403/404)
- ✅ **Fixed:** Better error handling for node status checks with 403 detection

**Changes Made:**
- Added `cluster_resources` fallback in `list_vms` when node-specific API returns 403/404
- Improved error messages to distinguish node not found vs access denied
- Node normalization verified in all code paths

---

#### **(B) Migration Logic Falsely Saying Nodes Are Offline** ✅ **FIXED**

**Status:** Preflight checks now properly distinguish error types

**Evidence:**
- ✅ `runMigrationPreFlightChecks()` exists (line 902)
- ✅ Checks `/nodes/${node}/status` for both source and target with proper error handling
- ✅ **Fixed:** `getVmStatus()` now throws errors with status codes for better handling
- ✅ **Fixed:** Preflight checks now distinguish between:
  - Node offline (403/404 on node status)
  - Wrong VM type (500 on one type, success on other)
  - VM doesn't exist (both types fail)
- ✅ **Fixed:** Error messages clearly indicate the issue type

**Changes Made:**
- Enhanced `getVmStatus()` to throw errors with status codes
- Added type checking fallback: if LXC fails with 500, tries QEMU (and vice versa)
- Improved error messages in preflight checks to distinguish error types
- Added 403 detection for node access issues

---

#### **(C) Missing "destroy_vm" support** ✅ **FIXED**

**Status:** Now fully supported with safety checks

**Evidence:**
- ✅ `destroy_vm` added to action enum and schema
- ✅ Implemented with safety checks (VM must be stopped first)
- ✅ Added to CLI write dispatcher (`destroy-vm` command)
- ✅ Updated system prompt with warnings about destructive nature
- ✅ Includes dry-run support
- ✅ Error handling for running VMs (blocks destruction if running)

**Changes Made:**
- Added `destroy_vm` to `ProxmoxWriteParams` enum
- Implemented `destroyVm()` method with pre-flight checks
- Added CLI command: `destroy-vm` (requires --node, --vmid, optional --type)
- Updated system prompt to mention destroy_vm is supported but destructive
- Added warning logs for extreme-risk operations

---

#### **(D) glances tool: ECONNREFUSED** ✅ **VALID (Environment Issue)**

**Status:** Code is correct, but glances service not running

**Evidence:**
- ✅ GlancesTool exists (`src/tools/GlancesTool.ts`)
- ✅ Hardcoded to `http://127.0.0.1:61208` (line 54)
- ⚠️ **Issue:** No fallback or error handling for service not running
- ⚠️ **Issue:** No configuration for different hosts

**Fix Needed:**
- Add environment variable for Glances URL
- Add graceful fallback when service unavailable
- Or document that glances must be installed on nodes

---

### **2. Reasoning Layer Issues**

#### **(A) Missing ontology / cluster roles → "What is the purpose of every workload?" falls flat** ✅ **VALID**

**Status:** Purpose/intent metadata not extracted

**Evidence:**
- ✅ Entity extraction exists (`src/pce/edl/extraction/extractor.ts`)
- ✅ Basic attributes extracted: `name`, `hostname` (EDL pipeline lines 94-99)
- ❌ **Missing:** `purpose`, `intent`, `role`, `workload_type` attributes
- ✅ Proxmox ingestion extracts: `node`, `status`, `cpu`, `memory` but NOT purpose

**Fix Needed:**
- Add purpose/intent extraction to EDL
- Ingest topology.yaml with tagged intent if available
- Add purpose attribute to ontology schema

---

#### **(B) Hybrid RAG sometimes returns nothing** ✅ **FIXED**

**Status:** Threshold lowered and exact-match fallback implemented

**Evidence:**
- ✅ **Fixed:** Similarity threshold lowered from `0.15` to `0.10` (retrieval.ts line 16)
- ✅ Fusion minTotalScore: `0.25` (fusion.ts line 30)
- ✅ Query entity resolver has exact match logic (query-entity-resolver.ts line 161, 228, 305)
- ✅ **Fixed:** Exact-match fallback added BEFORE semantic search for VM names

**Changes Made:**
- Lowered similarity threshold from `0.15` to `0.10` for better recall
- Added `tryExactMatchFallback()` method in `hybrid-orchestrator.ts`
- Checks graph for exact VM name matches (patterns: "vm-123", "container-456", "lxc-789", etc.)
- Returns perfect score (1.0) for exact matches, bypassing semantic search
- Handles 3+ digit numbers as potential VMIDs

---

#### **(C) Cross-system correlation is not implemented yet** ✅ **VALID (Feature Gap)**

**Status:** Works but requires many tool calls

**Evidence:**
- ✅ Tools exist: `proxmox_readonly`, `opnsense_readonly`, `ssh_execute`
- ❌ **Missing:** Orchestration layer that correlates across systems
- ✅ System prompt guides multi-tool usage, but no automated coordination

**Fix Needed:**
- Phase IV orchestration engine (as noted)
- Or add composite queries like "containers_without_ips"

---

### **3. Data Gaps (Your Environment)**

#### **(A) Some LXCs don't show in DHCP leases** ✅ **VALID (Environment Issue)**

**Status:** Not a code bug - environment configuration issue

**Evidence:**
- ✅ DHCP lease lookup exists (`opnsense_readonly` tool)
- ✅ IP resolution workflow exists with fallbacks
- ⚠️ **Issue:** Static IPs or lost leases won't appear

**Fix Needed:**
- Environment configuration (standardize DHCP)
- Or add static IP mapping capability

---

#### **(B) Missing guest agent on QEMU VMs** ✅ **VALID (Environment Issue)**

**Status:** Code handles fallback, but guest agent missing

**Evidence:**
- ✅ IP resolution has fallback logic (proxmox-readonly-tool.ts)
- ✅ Guest agent endpoint: `/nodes/{node}/qemu/{vmid}/agent/network-get-interfaces`
- ⚠️ **Issue:** When guest agent unavailable, falls back to config parsing

**Fix Needed:**
- Install qemu-guest-agent on VMs (environment fix)
- Or improve fallback logic

---

### **4. Feature Gaps**

#### **(A) No Proxmox write command support in CLI** ❌ **INVALID**

**Status:** Write commands ARE supported in CLI

**Evidence:**
- ✅ `writeActions` map exists (cli.ts lines 444-450)
- ✅ Write dispatcher implemented (lines 521-552)
- ✅ Supports: `start-vm`, `stop-vm`, `reset-vm`, `shutdown-vm`, `migrate-vm`
- ✅ Help menu shows write actions (lines 485-490)

**Note:** User may be confused or referring to a different issue. CLI write support exists.

---

#### **(B) No tool for "list everything hosted on a node"** ✅ **FIXED**

**Status:** `list_vms` now has fallback to `cluster_resources`

**Evidence:**
- ✅ `list_vms` action exists (proxmox-readonly-tool.ts)
- ✅ `cluster_resources` can filter by node
- ✅ **Fixed:** Automatic fallback to `cluster_resources` when node-specific call fails (403/404)
- ✅ **Fixed:** Filters results by node name automatically
- ✅ **Fixed:** Provides helpful hints when fallback is used

**Changes Made:**
- Added try-catch in `list_vms` handler
- On 403/404, falls back to `cluster_resources` filtered by node
- Returns filtered results with `_fallback: true` flag and helpful hint
- Node normalization still applied before attempting node-specific call

---

#### **(C) Multi-tool coordination is primitive** ✅ **VALID**

**Status:** Works but requires explicit LLM orchestration

**Evidence:**
- ✅ System prompt guides multi-tool usage
- ✅ Tool calling exists in runner.ts
- ❌ **Missing:** Automated orchestration templates
- ❌ **Missing:** Pre-flight coordination logic

**Fix Needed:**
- Phase IV orchestration engine (as noted)
- Or add orchestration templates for common workflows

---

## 📊 **VALIDATION SUMMARY**

| Issue | Status | Priority | Notes |
|-------|--------|----------|-------|
| Node name 403s | ✅ **FIXED** | HIGH | Fallback to cluster_resources added |
| LXC migration preflight | ✅ **FIXED** | HIGH | Error handling improved, type checking added |
| Missing destroy_vm | ✅ **FIXED** | MEDIUM | Fully implemented with safety checks |
| glances ECONNREFUSED | ✅ Valid | LOW | Environment issue (code is correct) |
| Missing purpose metadata | ✅ Valid | MEDIUM | Feature gap (P2 - not yet implemented) |
| RAG threshold too strict | ✅ **FIXED** | MEDIUM | Threshold lowered, exact-match fallback added |
| Cross-system correlation | ✅ Valid | LOW | Phase IV feature (not yet implemented) |
| DHCP lease gaps | ✅ Valid | LOW | Environment issue (not a code bug) |
| Guest agent missing | ✅ Valid | LOW | Environment issue (not a code bug) |
| CLI write support | ❌ Invalid | - | Already implemented (was never an issue) |
| Node inventory tool | ✅ **FIXED** | MEDIUM | cluster_resources fallback added |
| Multi-tool coordination | ✅ Valid | LOW | Phase IV feature (not yet implemented) |

---

## 🎯 **FIX STATUS**

### **P0 (Critical - Blocks Operations)** ✅ **ALL COMPLETED**
1. ✅ **COMPLETED** - Fix LXC migration preflight error handling
   - Enhanced error handling to distinguish node offline vs wrong type vs VM missing
   - Added type checking fallback (tries both qemu and lxc)
   - Improved error messages with status code detection
2. ✅ **COMPLETED** - Ensure node normalization called in ALL paths
   - Verified normalization in all code paths
   - Added cluster_resources fallback for node-specific calls
3. ✅ **COMPLETED** - Add destroy_vm support
   - Fully implemented with safety checks (must be stopped first)
   - Added to CLI and system prompt
   - Includes dry-run support

### **P1 (High Impact)** ✅ **ALL COMPLETED**
4. ✅ **COMPLETED** - Lower RAG threshold to 0.10
   - Changed from 0.15 to 0.10 in retrieval.ts
5. ✅ **COMPLETED** - Add exact-match fallback for VM names
   - Implemented `tryExactMatchFallback()` in hybrid-orchestrator.ts
   - Checks graph before semantic search for VM name patterns
   - Returns perfect score (1.0) for exact matches
6. ✅ **COMPLETED** - Improve node inventory tool (cluster_resources fallback)
   - Added automatic fallback when node-specific call fails
   - Filters by node name automatically

### **P2 (Quality of Life)** ⏳ **NOT YET IMPLEMENTED**
7. ⏳ Add purpose metadata extraction (Feature gap - not yet implemented)
8. ⏳ Better glances error handling (Environment issue - code is correct)
9. ⏳ Document environment requirements (Documentation task - not yet done)

---

## 🔍 **CODE REFERENCES**

### Node Normalization
- `src/tools/proxmox/readonly/proxmox-readonly-tool.ts:393-508` (normalizeNodeName)
- `src/tools/proxmox/writes/proxmox-write-tool.ts:199-314` (normalizeNodeName)
- `src/tools/proxmox/readonly/proxmox-readonly-tool.ts:234-256` (list_vms with cluster_resources fallback)

### Migration Preflight (FIXED)
- `src/tools/proxmox/writes/proxmox-write-tool.ts:902-1015` (runMigrationPreFlightChecks)
- `src/tools/proxmox/writes/proxmox-write-tool.ts:1020-1032` (getVmStatus with error throwing)
- Enhanced error handling distinguishes: node offline (403), wrong type (500 on one type), VM missing (both fail)

### RAG Thresholds (FIXED)
- `src/pce/rag/retrieval.ts:16` (similarityThreshold: **0.10** - lowered from 0.15)
- `src/pce/rag/fusion.ts:30` (minTotalScore: 0.25)
- `src/pce/rag/hybrid-orchestrator.ts:555-664` (tryExactMatchFallback - NEW)

### CLI Write Support
- `src/cli.ts:444-450` (writeActions map - includes destroy-vm)
- `src/cli.ts:521-552` (write dispatcher)
- `src/cli.ts:491` (destroy-vm help text)

### destroy_vm Implementation (FIXED)
- `src/tools/proxmox/writes/proxmox-write-tool.ts:13-23` (enum - includes destroy_vm)
- `src/tools/proxmox/writes/proxmox-write-tool.ts:1182-1280` (destroyVm method - NEW)
- `src/agent/system-prompt.ts:28` (updated to mention destroy_vm is supported)

### Node Inventory Fallback (FIXED)
- `src/tools/proxmox/readonly/proxmox-readonly-tool.ts:234-256` (list_vms with try-catch and cluster_resources fallback)

### Missing Features (Not Yet Implemented)
- `purpose` metadata: Not in EDL pipeline (edl/pipeline.ts:94-99) - P2 feature gap

