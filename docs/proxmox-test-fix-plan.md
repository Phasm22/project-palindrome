# Proxmox Test Fix Plan

## Current Status

Based on test run results:
- **TL-2A.1: Client** - 10 failures
- **TL-2A.2: Tool Actions** - 7 failures  
- **TL-2A.4: Redaction** - 6 failures
- **TL-2A.6.A: Vector Ingestion** - 1 failure
- **TL-2A.7: Hybrid Reasoning** - ✅ 5/5 passing (working!)

**Total**: 24 failures to fix

---

## Step-by-Step Fix Plan

### Step 1: Run Tests to Get Specific Errors

```bash
# Use the test script
./scripts/test-proxmox.sh

# Or run individually:
~/.bun/bin/bun test tests/tools/proxmox/readonly/client.test.ts
~/.bun/bin/bun test tests/tools/proxmox/readonly/proxmox-readonly-tool.test.ts
~/.bun/bin/bun test tests/tools/proxmox/readonly/redaction.test.ts
~/.bun/bin/bun test tests/tools/proxmox/readonly/vector-ingestion.test.ts
```

### Step 2: Fix Client Tests (TL-2A.1) - 10 failures

**Likely Issues**:
- Mock setup not working correctly
- `mockAxiosCreate` not returning instance properly
- `beforeEach` not resetting mocks correctly

**Fix Strategy**:
1. Check if `mockAxiosCreate` is being called correctly
2. Verify `mockAxiosInstance` is returned from `create()`
3. Ensure mocks are reset in `beforeEach`
4. Check if ProxmoxClient constructor is using mocked axios

### Step 3: Fix Tool Action Tests (TL-2A.2) - 7 failures

**Likely Issues**:
- `getApiClient()` not returning mocked client
- Tool execution not using mocked API calls
- Response format mismatches

**Fix Strategy**:
1. Verify `getApiClient()` mock is working
2. Check if tool actions are calling mocked client methods
3. Ensure response format matches expectations
4. Verify normalization is applied correctly

### Step 4: Fix Redaction Tests (TL-2A.4) - 6 failures

**Likely Issues**:
- Pattern order conflicts
- Test expectations don't match actual redaction
- Pattern regex not matching correctly

**Fix Strategy**:
1. Review pattern order in `src/pce/redaction/patterns.ts`
2. Test each pattern individually
3. Update test expectations to match actual behavior
4. Verify replacement functions work correctly

### Step 5: Fix Vector Ingestion Test (TL-2A.6.A) - 1 failure

**Likely Issues**:
- Mock setup issue (if still showing vi.hoisted error, file wasn't saved)
- Tool mock not working correctly
- Document generation logic issue

**Fix Strategy**:
1. Verify file has correct mock setup (no vi.hoisted)
2. Check if ProxmoxReadOnlyTool mock is working
3. Verify document generation functions

---

## Quick Fixes to Try First

### Fix 1: Ensure mockAxiosCreate Returns Instance

In all test files, make sure:
```typescript
const mockAxiosCreate = vi.fn(() => mockAxiosInstance);
```

And in the mock:
```typescript
vi.mock("axios", () => ({
  default: {
    create: () => mockAxiosCreate(),
  },
}));
```

### Fix 2: Reset Mocks in beforeEach

Make sure all test files have:
```typescript
beforeEach(() => {
  vi.clearAllMocks();
  mockAxiosInstance.get.mockClear();
  mockAxiosInstance.post.mockClear();
  // ... etc
  mockAxiosCreate.mockReturnValue(mockAxiosInstance);
});
```

### Fix 3: Verify ProxmoxClient Uses Mocked Axios

The ProxmoxClient should be using the mocked axios. Check if it's importing axios correctly.

---

## Next Actions

1. **Run the test script** to see actual errors:
   ```bash
   ./scripts/test-proxmox.sh > /tmp/proxmox-test-results.txt 2>&1
   ```

2. **Review errors** and identify patterns

3. **Fix systematically** starting with client tests (foundation)

4. **Re-run tests** after each fix to verify

---

## Files to Check/Modify

1. `tests/tools/proxmox/readonly/client.test.ts` - Client mocking
2. `tests/tools/proxmox/readonly/base.test.ts` - Base class mocking
3. `tests/tools/proxmox/readonly/proxmox-readonly-tool.test.ts` - Tool action tests
4. `tests/tools/proxmox/readonly/redaction.test.ts` - Redaction patterns
5. `tests/tools/proxmox/readonly/vector-ingestion.test.ts` - Vector ingestion
6. `src/pce/redaction/patterns.ts` - Redaction pattern order

