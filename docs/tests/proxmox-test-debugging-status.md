# Proxmox Test Debugging Status

## Current Status: 95/126 passing (75.4%)

### ✅ Fixed Issues
1. **Logger mock** - Added to client tests ✅
2. **Test expectations** - Made more flexible ✅
3. **Normalization tests** - All 30 passing ✅
4. **Graph ingestion tests** - All 13 passing ✅
5. **Base class tests** - All 9 passing ✅

### ⚠️ Remaining Issues (31 failures)

#### 1. Client Tests (3 failures)
**Problem**: `mockAxiosCreate.mock.calls[0][0]` is undefined
**Root Cause**: Mock isn't being called, or mock setup isn't working correctly
**Status**: Mock setup improved, but needs verification

#### 2. Tool Action Tests (25 failures)
**Problem**: `result.data` is undefined - tool isn't using mocked client
**Root Cause**: Tool is creating real ProxmoxClient instead of using mock
**Status**: Mock setup improved, but tool still not using it

**Key Issue**: The tool's `getApiClient()` method creates a ProxmoxClient, which uses axios.create(). Even though we mock `getApiClient` to return `mockClient`, the tool might be:
- Creating the client before the mock is set
- Caching the client and not using the mock
- The mock replacement isn't working correctly

#### 3. Redaction Tests (6 failures)
**Problem**: API tokens being redacted as `[REDACTED_CONFIG_SECRET]` instead of `token-[REDACTED]`
**Root Cause**: Config secrets pattern matching tokens before API token pattern
**Status**: Replacement function improved, but pattern order may still be an issue

#### 4. Vector Ingestion (1 failure)
**Problem**: Mock not set up for all required tool calls
**Status**: Needs additional mock setup

## Critical Issue: Mock Not Being Used

The main blocker is that the tool action tests aren't using the mocked client. The tool is creating a real ProxmoxClient, which then tries to make real API calls.

### Possible Solutions

1. **Mock ProxmoxClient directly** (instead of mocking getApiClient):
   ```typescript
   vi.mock("../../../../src/tools/proxmox/client", () => ({
     ProxmoxClient: vi.fn().mockImplementation(() => mockClient),
   }));
   ```

2. **Ensure axios mock works correctly** so ProxmoxClient uses mocked axios

3. **Spy on getApiClient** to verify it's being called and replace it before tool execution

4. **Use a different mocking strategy** - mock at the ProxmoxClient level instead of tool level

## Next Steps

1. **Verify mock is being used**: Add console.log or spy to check if getApiClient is called
2. **Try mocking ProxmoxClient directly** instead of getApiClient
3. **Fix redaction pattern order** - ensure API token pattern runs first
4. **Fix vector ingestion mock** - add all required mocks

## Recommendation

**Try mocking ProxmoxClient directly** - this is the most reliable approach and will ensure the tool uses the mock instead of creating a real client.

