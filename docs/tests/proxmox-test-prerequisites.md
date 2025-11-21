# Proxmox Test Prerequisites

## TL-2A.7 Hybrid Reasoning Gold Path Test Requirements

### Required Environment Variables

#### 1. **OPENAI_API_KEY** (Required for LLM calls)
```bash
OPENAI_API_KEY=sk-...
```
- **Status**: ✅ You have this
- **Purpose**: Used by the agent to make LLM calls for reasoning and synthesis
- **Note**: The test will skip if this is not set or is "test-key"

#### 2. **PCE_API_URL** (Required for Vector/Graph RAG)
```bash
PCE_API_URL=http://localhost:4000
```
- **Status**: ⚠️ Your PCE API is running on port 4000 (test expects 3000)
- **Purpose**: Used to fetch Vector RAG and Graph RAG context
- **Note**: The test mocks this, but if you want real RAG data, set this to your PCE API URL

#### 3. **PROXMOX_URL** (Optional - only if making real Proxmox calls)
```bash
PROXMOX_URL=https://your-proxmox-host.example.com
```
- **Status**: ❌ Not set up yet
- **Purpose**: Proxmox VE API endpoint
- **Note**: The test sets mock values, but real tool calls would need this

#### 4. **PROXMOX_TOKEN_ID** (Optional - only if making real Proxmox calls)
```bash
PROXMOX_TOKEN_ID=user@realm!tokenname
```
- **Status**: ❌ Not created yet
- **Purpose**: Proxmox API token identifier
- **Format**: `username@realm!tokenname` (e.g., `automation@pam!api-token`)
- **Note**: The test sets mock values, but real tool calls would need this

#### 5. **PROXMOX_TOKEN_SECRET** (Optional - only if making real Proxmox calls)
```bash
PROXMOX_TOKEN_SECRET=your-token-secret
```
- **Status**: ❌ Not created yet
- **Purpose**: Proxmox API token secret
- **Note**: The test sets mock values, but real tool calls would need this

### Current Test Behavior

The TL-2A.7 test:
1. ✅ **Mocks PCE API calls** - Uses `mockFetch` to simulate Vector/Graph RAG responses
2. ✅ **Sets mock Proxmox credentials** - Test sets fake values in `beforeEach`
3. ⚠️ **Makes real OpenAI API calls** - Requires valid `OPENAI_API_KEY`
4. ⚠️ **May make real Proxmox calls** - If the LLM decides to call the tool, it would need real credentials

### To Run the Test Successfully

**Minimum Requirements:**
- ✅ `OPENAI_API_KEY` set in your environment
- ✅ PCE API running (or test will mock it)

**For Full Integration (Real Proxmox Calls):**
1. Create a Proxmox API token:
   ```bash
   # In Proxmox Web UI:
   # Datacenter → Permissions → API Tokens → Add
   # User: automation@pam
   # Token ID: api-token
   # Permissions: Read-only (Sys.Audit on /)
   ```

2. Add to `.env`:
   ```bash
   PROXMOX_URL=https://your-proxmox-host.example.com
   PROXMOX_TOKEN_ID=automation@pam!api-token
   PROXMOX_TOKEN_SECRET=your-generated-secret
   PROXMOX_VERIFY_SSL=true
   ```

3. Ensure PCE API is running:
   ```bash
   bun run pce:api
   # Should be on http://localhost:4000
   ```

### Test Issues to Fix

1. **Port Mismatch**: Test expects PCE API on port 3000, but yours is on 4000
2. **Mock Setup**: Test uses `vi.fn()` from vitest but imports from `bun:test` (should use `spyOn`)
3. **Fetch Mock**: May not be intercepting OpenAI API calls properly

### Quick Fix for Test

Update the test to use the correct port:
```typescript
PCE_API_URL: "http://localhost:4000",  // Change from 3000 to 4000
```

Or set in your `.env`:
```bash
PCE_API_URL=http://localhost:4000
```

