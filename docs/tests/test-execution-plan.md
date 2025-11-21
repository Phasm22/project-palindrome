# Test Execution Plan & Failure Tracking

## Test Execution Order

Tests should be run in this order to ensure dependencies are met:

1. **Phase I-A** (Foundation: DLM, Redaction, Chunking, Vector DB)
2. **Phase I-B** (Knowledge Graph: Entity Extraction, Normalization, Graph Queries)
3. **Phase I-C** (Hybrid Orchestration: Query Routing, Fusion, LLM Synthesis)
4. **Phase II** (Real-Time & Scaling: Webhooks, Metrics, Performance)
5. **Phase III** (External API & Security: API Layer, Tool Use, Provenance Audit)
6. **Phase TL-1A** (OPNsense Read-Only Tools)
7. **Phase TL-1B** (OPNsense Safe Write Tools)
8. **Phase TL-1C** (LLM-Integrated Tool Use)
9. **Phase TL-2A** (Proxmox Read-Only Tools)

## Test Commands

```bash
# Phase I-A
bun test tests/pce/dod.test.ts

# Phase I-B
bun test tests/pce/phase-ib-dod.test.ts

# Phase I-C
bun test tests/pce/phase-ic-dod.test.ts

# Phase II
bun test tests/pce/phase-ii-dod.test.ts

# Phase III
bun test tests/pce/api/api-server.test.ts
bun test tests/tools/cognitive-tools.test.ts
bun run scripts/run-gold-path.ts
bun run pce:provenance-audit

# Phase TL-1A
bun test tests/tools/opnsense/readonly/

# Phase TL-1B
bun test tests/tools/opnsense/writes/

# Phase TL-1C
bun test tests/flows/opnsense_llm_tool_calling.test.ts
bun test tests/flows/opnsense_diagnostic_reasoning.test.ts
bun test tests/flows/opnsense_assisted_config.test.ts
bun test tests/flows/opnsense_provenance.test.ts

# Phase TL-2A
bun test tests/tools/proxmox/readonly/
bun test tests/flows/proxmox_hybrid_reasoning.test.ts
```

## Known Test Failures (From Previous Runs)

### Phase TL-2A: Proxmox Read-Only Tools

**Status**: 79/126 tests passing (62.7% pass rate)

**Failing Test Suites**:

1. **TL-2A.1: Proxmox REST Client & Provenance** (17 failures)
   - **Issue**: `ProxmoxClient` is `undefined` in tests
   - **Root Cause**: Vitest module mocking issue with axios
   - **Error**: `TypeError: undefined is not an object (evaluating 'new ProxmoxClient(mockConfig).get')`
   - **Files**: `tests/tools/proxmox/readonly/client.test.ts`
   - **Fix Needed**: Correct axios mock setup in Vitest

2. **TL-2A.2: Core Action Implementation** (25 failures)
   - **Issue**: Tool action tests failing
   - **Root Cause**: Likely related to ProxmoxClient mocking issue
   - **Files**: `tests/tools/proxmox/readonly/proxmox-readonly-tool.test.ts`
   - **Fix Needed**: Fix base class mocking and API client access

3. **TL-2A.4: CRITICAL Redaction Test** (9 failures)
   - **Issue**: Redaction pattern tests failing
   - **Root Cause**: Pattern conflicts and test expectations
   - **Files**: `tests/tools/proxmox/readonly/redaction.test.ts`
   - **Fix Needed**: 
     - Verify redaction pattern order
     - Fix test expectations for API token and config secrets patterns
     - Ensure patterns don't conflict with each other

4. **TL-2A.5: Structured Normalization Test** (1 failure)
   - **Issue**: `normalizeStatus` numeric status code mapping
   - **Root Cause**: Test expectation mismatch
   - **Files**: `tests/tools/proxmox/readonly/normalization.test.ts`
   - **Fix Needed**: Verify `normalizeStatus(0)` and `normalizeStatus(1)` return correct values

5. **TL-2A.6.A: Vector Store Ingestion** (1 failure)
   - **Issue**: Document generation test failing
   - **Root Cause**: Mock setup issue
   - **Files**: `tests/tools/proxmox/readonly/vector-ingestion.test.ts`
   - **Fix Needed**: Fix ProxmoxReadOnlyTool mock in test

6. **TL-2A.6.B: Graph Store Ingestion** (No failures reported)
   - **Status**: Tests should be passing

7. **TL-2A.7: Hybrid Reasoning Gold Path** (5/5 passing ✅)
   - **Status**: All tests passing
   - **Note**: Proxmox API calls may fail, but tests are resilient

## Debugging Task List

### High Priority (Blocking Core Functionality)

1. **Fix ProxmoxClient Mocking in Vitest**
   - **File**: `tests/tools/proxmox/readonly/client.test.ts`
   - **Issue**: `ProxmoxClient` is undefined when imported
   - **Impact**: 17+ test failures in client tests
   - **Action**: 
     - Verify axios mock is set up correctly before import
     - Check if Vitest hoisting is causing issues
     - Consider using `vi.hoisted()` for mock setup
     - Verify https module mock is working

2. **Fix Base Class Mocking for Tool Tests**
   - **File**: `tests/tools/proxmox/readonly/proxmox-readonly-tool.test.ts`
   - **File**: `tests/tools/proxmox/readonly/base.test.ts`
   - **Issue**: `getApiClient` method not properly mocked
   - **Impact**: 25+ test failures in tool action tests
   - **Action**:
     - Fix mock setup for `ProxmoxReadOnlyBase.getApiClient()`
     - Ensure mock returns proper axios instance
     - Verify execution context is properly mocked

3. **Fix Redaction Pattern Conflicts**
   - **File**: `tests/tools/proxmox/readonly/redaction.test.ts`
   - **File**: `src/pce/redaction/patterns.ts`
   - **Issue**: Pattern order causing conflicts, test expectations incorrect
   - **Impact**: 9 test failures in redaction tests
   - **Action**:
     - Verify pattern order (API tokens before user realms)
     - Fix config secrets pattern to exclude tokens
     - Update test expectations to match actual redaction behavior
     - Test pattern interactions

### Medium Priority (Test Infrastructure)

4. **Fix Normalization Test**
   - **File**: `tests/tools/proxmox/readonly/normalization.test.ts`
   - **Issue**: `normalizeStatus(0)` and `normalizeStatus(1)` test failing
   - **Impact**: 1 test failure
   - **Action**:
     - Verify `normalizeStatus` function implementation
     - Check if status map includes "0" and "1" keys
     - Fix test expectations or function implementation

5. **Fix Vector Ingestion Test Mock**
   - **File**: `tests/tools/proxmox/readonly/vector-ingestion.test.ts`
   - **Issue**: ProxmoxReadOnlyTool mock not working correctly
   - **Impact**: 1 test failure
   - **Action**:
     - Verify mock setup for ProxmoxReadOnlyTool constructor
     - Ensure mock instance is returned correctly
     - Fix test expectations

### Low Priority (Non-Critical)

6. **Investigate Proxmox API Call Failures in Integration Tests**
   - **File**: `tests/flows/proxmox_hybrid_reasoning.test.ts`
   - **Issue**: Proxmox API calls failing (but tests still pass)
   - **Impact**: Tests pass but API calls fail
   - **Action**:
     - Verify Proxmox credentials are loaded correctly
     - Check if URL normalization is working
     - Verify SSL verification settings
     - Test actual API connectivity

## Test Execution Results Template

```markdown
## Test Run: [DATE]

### Phase I-A: Foundation
- **Status**: [PASS/FAIL]
- **Passing**: X/Y tests
- **Failures**: [List failures]

### Phase I-B: Knowledge Graph
- **Status**: [PASS/FAIL]
- **Passing**: X/Y tests
- **Failures**: [List failures]

### Phase I-C: Hybrid Orchestration
- **Status**: [PASS/FAIL]
- **Passing**: X/Y tests
- **Failures**: [List failures]

### Phase II: Real-Time & Scaling
- **Status**: [PASS/FAIL]
- **Passing**: X/Y tests
- **Failures**: [List failures]

### Phase III: External API & Security
- **Status**: [PASS/FAIL]
- **Passing**: X/Y tests
- **Failures**: [List failures]

### Phase TL-1A: OPNsense Read-Only
- **Status**: [PASS/FAIL]
- **Passing**: X/Y tests
- **Failures**: [List failures]

### Phase TL-1B: OPNsense Safe Write
- **Status**: [PASS/FAIL]
- **Passing**: X/Y tests
- **Failures**: [List failures]

### Phase TL-1C: LLM-Integrated Tool Use
- **Status**: [PASS/FAIL]
- **Passing**: X/Y tests
- **Failures**: [List failures]

### Phase TL-2A: Proxmox Read-Only
- **Status**: [PASS/FAIL]
- **Passing**: 79/126 tests (62.7%)
- **Failures**: 47 tests (see Known Failures section)
```

## Next Steps

1. Run all test suites in order
2. Document all failures
3. Prioritize fixes based on impact
4. Fix high-priority issues first
5. Re-run tests after each fix
6. Update this document with results

