# Test Failures Debug List

## Last Updated: [Current Date]

This document tracks all known test failures and debugging tasks.

---

## Phase TL-2A: Proxmox Read-Only Tools

### Current Status: 79/126 tests passing (62.7% pass rate)

### Critical Failures (47 tests failing)

#### 1. TL-2A.1: Proxmox REST Client & Provenance (17 failures)

**Test File**: `tests/tools/proxmox/readonly/client.test.ts`

**Error Pattern**:
```
TypeError: undefined is not an object (evaluating 'new ProxmoxClient(mockConfig).get')
TypeError: undefined is not an object (evaluating 'client.get')
```

**Root Cause**: 
- `ProxmoxClient` is `undefined` when imported in tests
- Vitest module mocking issue with axios
- Mock setup happens after import, causing hoisting issues

**Affected Tests**:
- Client Initialization (7 tests)
- GET Request with Provenance (2 tests)
- Provenance ID Format (2 tests)
- Error Handling (1 test)
- Endpoint Support (3 tests)
- fromEnvironment (2 tests)

**Debug Tasks**:
- [ ] Verify axios mock is set up before ProxmoxClient import
- [ ] Check Vitest hoisting behavior for module mocks
- [ ] Use `vi.hoisted()` for mock setup if needed
- [ ] Verify https module mock is working correctly
- [ ] Test if moving mock setup to top-level helps
- [ ] Check if axios default export is mocked correctly

**Fix Priority**: 🔴 **CRITICAL** (blocks 17+ tests)

---

#### 2. TL-2A.2: Core Action Implementation (25 failures)

**Test File**: `tests/tools/proxmox/readonly/proxmox-readonly-tool.test.ts`

**Error Pattern**:
- Likely related to ProxmoxClient mocking issue
- `getApiClient` method not accessible or mocked incorrectly

**Affected Tests**:
- Node-Level Actions (5 tests)
- VM-Level Actions (5 tests)
- Cluster-Level Actions (6 tests)
- Parameter Validation (3 tests)
- Read-Only Enforcement (1 test)
- Provenance Tracking (1 test)

**Debug Tasks**:
- [ ] Fix `ProxmoxReadOnlyBase.getApiClient()` mock
- [ ] Ensure mock returns proper axios instance with interceptors
- [ ] Verify execution context is properly mocked
- [ ] Check if base class mocking is working
- [ ] Test tool execution with mocked API client

**Fix Priority**: 🔴 **CRITICAL** (blocks 25+ tests)

---

#### 3. TL-2A.4: CRITICAL Redaction Test (9 failures)

**Test File**: `tests/tools/proxmox/readonly/redaction.test.ts`

**Error Pattern**:
- Pattern conflicts between API tokens and user realms
- Config secrets pattern matching tokens incorrectly
- Test expectations don't match actual redaction behavior

**Affected Tests**:
- Pattern 2: API Token Names (2 tests)
- Integration: All Patterns Together (1 test)
- End-to-End: sanitizeToolPayload Integration (2 tests)
- Real-World Proxmox API Response Examples (2 tests)

**Debug Tasks**:
- [ ] Verify pattern order: API tokens before user realms
- [ ] Fix config secrets pattern to exclude tokens with @realm! format
- [ ] Update test expectations to match actual redaction behavior
- [ ] Test pattern interactions (ensure no conflicts)
- [ ] Verify replacement functions work correctly
- [ ] Test edge cases (tokens in config files, etc.)

**Fix Priority**: 🟡 **HIGH** (security-critical, but tests are close)

---

#### 4. TL-2A.5: Structured Normalization Test (1 failure)

**Test File**: `tests/tools/proxmox/readonly/normalization.test.ts`

**Error Pattern**:
- `normalizeStatus(0)` and `normalizeStatus(1)` test failing
- Expected: "stopped" and "running"
- Actual: May be returning different values

**Affected Tests**:
- `should map numeric status codes`

**Debug Tasks**:
- [ ] Verify `normalizeStatus` function implementation
- [ ] Check if status map includes "0" and "1" keys
- [ ] Test function with numeric inputs directly
- [ ] Fix test expectations or function implementation
- [ ] Verify string conversion is working correctly

**Fix Priority**: 🟢 **MEDIUM** (1 test, easy fix)

---

#### 5. TL-2A.6.A: Vector Store Ingestion (1 failure)

**Test File**: `tests/tools/proxmox/readonly/vector-ingestion.test.ts`

**Error Pattern**:
- ProxmoxReadOnlyTool mock not working correctly
- Mock instance not returned from constructor

**Affected Tests**:
- `should generate all documents for a cluster`

**Debug Tasks**:
- [ ] Verify mock setup for ProxmoxReadOnlyTool constructor
- [ ] Ensure mock instance is returned correctly
- [ ] Check if `vi.fn().mockImplementation()` is working
- [ ] Fix test expectations for mock calls
- [ ] Verify document generation functions work with mocked tool

**Fix Priority**: 🟢 **MEDIUM** (1 test, likely mock issue)

---

## Test Execution Results

### Phase I-A: Foundation
- **Status**: ⏳ **PENDING**
- **Tests**: `tests/pce/dod.test.ts`, `tests/pce/redaction.test.ts`, `tests/pce/dlm.test.ts`
- **Last Run**: [Not run yet]
- **Failures**: [TBD]

### Phase I-B: Knowledge Graph
- **Status**: ⏳ **PENDING**
- **Tests**: `tests/pce/phase-ib-dod.test.ts`, `tests/pce/kg/test-harness.test.ts`
- **Last Run**: [Not run yet]
- **Failures**: [TBD]

### Phase I-C: Hybrid Orchestration
- **Status**: ⏳ **PENDING**
- **Tests**: `tests/pce/phase-ic-dod.test.ts`, `tests/pce/hybrid-orchestrator-score.test.ts`
- **Last Run**: [Not run yet]
- **Failures**: [TBD]

### Phase II: Real-Time & Scaling
- **Status**: ⏳ **PENDING**
- **Tests**: `tests/pce/phase-ii-dod.test.ts`
- **Last Run**: [Not run yet]
- **Failures**: [TBD]

### Phase III: External API & Security
- **Status**: ⏳ **PENDING**
- **Tests**: Multiple test files
- **Last Run**: [Not run yet]
- **Failures**: [TBD]

### Phase TL-1A: OPNsense Read-Only
- **Status**: ⏳ **PENDING**
- **Tests**: `tests/tools/opnsense/readonly/`
- **Last Run**: [Not run yet]
- **Failures**: [TBD]

### Phase TL-1B: OPNsense Safe Write
- **Status**: ⏳ **PENDING**
- **Tests**: `tests/tools/opnsense/writes/`
- **Last Run**: [Not run yet]
- **Failures**: [TBD]

### Phase TL-1C: LLM-Integrated Tool Use
- **Status**: ⏳ **PENDING**
- **Tests**: `tests/flows/opnsense_*.test.ts`
- **Last Run**: [Not run yet]
- **Failures**: [TBD]

### Phase TL-2A: Proxmox Read-Only
- **Status**: ⚠️ **PARTIAL** (79/126 passing, 47 failing)
- **Tests**: `tests/tools/proxmox/readonly/`, `tests/flows/proxmox_hybrid_reasoning.test.ts`
- **Last Run**: [Recent]
- **Failures**: See detailed breakdown above

---

## Debugging Strategy

### Step 1: Fix Critical Mocking Issues (Priority 1)
1. Fix ProxmoxClient mocking in `client.test.ts`
2. Fix base class mocking in `proxmox-readonly-tool.test.ts` and `base.test.ts`
3. Re-run tests to verify fixes

### Step 2: Fix Redaction Patterns (Priority 2)
1. Fix pattern order and conflicts
2. Update test expectations
3. Re-run redaction tests

### Step 3: Fix Remaining Issues (Priority 3)
1. Fix normalization test
2. Fix vector ingestion test
3. Re-run all tests

### Step 4: Run Full Test Suite
1. Execute `scripts/run-all-tests.sh`
2. Document all failures
3. Update this document with results

---

## Next Actions

1. **Run Test Execution Script**:
   ```bash
   ./scripts/run-all-tests.sh
   ```

2. **Fix Critical Issues First**:
   - Start with ProxmoxClient mocking
   - Then fix base class mocking
   - Then fix redaction patterns

3. **Update This Document**:
   - Add test execution results
   - Update failure counts
   - Mark completed debug tasks

4. **Re-run Tests After Each Fix**:
   - Verify fixes work
   - Check for regressions
   - Update pass/fail counts

