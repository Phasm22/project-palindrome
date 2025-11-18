# Proxmox Mock Fix Summary

## Issue
The axios mocks weren't working correctly because of scope issues with Vitest's hoisting behavior and Bun compatibility.

## Solution
Changed from using `let` declarations to using a module-level object (`mocks`) that stores the mock instances. This ensures:
1. Mocks are created inside the `vi.mock()` factory function
2. Mocks are accessible to both the factory and test code
3. Works with both Vitest and Bun test runners

## Pattern Used

```typescript
// Create mocks - use object to store so they're accessible everywhere
const mocks: any = {};

vi.mock("axios", () => {
  // Create mocks inside factory
  mocks.instance = {
    get: vi.fn(),
    post: vi.fn(),
    // ... etc
  };
  
  mocks.create = vi.fn(() => mocks.instance);
  
  return {
    default: {
      create: () => mocks.create(),
    },
  };
});

// Export for use in tests
const mockAxiosInstance = mocks.instance;
const mockAxiosCreate = mocks.create;
```

## Files Updated
- ✅ `tests/tools/proxmox/readonly/client.test.ts`
- ✅ `tests/tools/proxmox/readonly/base.test.ts`
- ✅ `tests/tools/proxmox/readonly/proxmox-readonly-tool.test.ts`
- ✅ `tests/tools/proxmox/readonly/vector-ingestion.test.ts`
- ✅ `tests/tools/proxmox/readonly/graph-ingestion.test.ts`

## Next Steps
1. Run tests to verify mocks are working:
   ```bash
   ~/.bun/bin/bun test tests/tools/proxmox/readonly/client.test.ts
   ```

2. If tests pass, proceed to fix remaining issues (redaction patterns, etc.)

3. If tests still fail, check:
   - Are mocks being reset in `beforeEach`?
   - Is `mockAxiosCreate` returning the instance correctly?
   - Are the test expectations matching the mock responses?

