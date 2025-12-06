# System Prompt Refactor Proposal

## Problems Identified

1. **Brittleness**: Hardcoded action names break on refactoring
2. **Over-constraining**: "Strict single-pass" prevents recovery/fallback
3. **Token economics**: Long prompt burns context window
4. **Circular authority**: Agent can't validate if action layer has bugs

## Proposed Solution

### 1. Principle-Based Prompt (Not Hardcoded)

**Current (Brittle):**
```
- For nginx: use action="services.install_nginx"
- For docker: use action="services.install_docker"
```

**Proposed (Flexible):**
```
- For service installation requests, use the "action" tool
- Available actions are discovered dynamically from the action registry
- Action tool schema provides examples and parameter shapes
- Match user intent to action domain (compute.*, network.*, services.*)
```

### 2. Allow Multi-Step When Needed

**Current (Over-constrained):**
```
Use strict single-pass planning: plan required tool calls upfront and execute them without multi-step deliberation unless necessary.
```

**Proposed (Balanced):**
```
- Default to single-pass planning for efficiency
- Allow multi-step deliberation when:
  * Compound requests require sequential execution
  * Action failures need recovery/fallback
  * Validation reveals unexpected state
  * Dependencies between actions exist
```

### 3. Move Examples to Tool Schemas

**Current (Token-heavy):**
- 130+ lines of hardcoded examples in system prompt
- Re-ingested every request

**Proposed (Efficient):**
- System prompt: Principles and patterns only (~30 lines)
- Tool schemas: Dynamic examples from action registry
- RAG: Detailed action documentation for complex cases
- Examples generated from `actionRegistry.list()` at runtime

### 4. Trust But Verify Pattern

**Current (Circular):**
```
DO NOT validate - action tool handles ALL validation internally
```

**Proposed (Flexible):**
```
- Trust action layer validation by default (efficiency)
- Allow optional validation when:
  * Action returns unexpected errors
  * User explicitly requests verification
  * Compound operations need state checks
  * Recovery from failures
- Validation should inform, not block (non-blocking sanity checks)
```

## Implementation Plan

### Phase 1: Extract Examples to Tool Schema
- Move action examples to `ActionTool.getSchema()`
- Generate examples dynamically from `actionRegistry.list()`
- Reduce system prompt by ~60%

### Phase 2: Principle-Based Guidance
- Replace hardcoded action names with domain patterns
- Use action registry to discover available actions
- Reference tool schemas for parameter shapes

### Phase 3: Flexible Planning
- Update planning guidance to allow multi-step when needed
- Add explicit recovery/fallback patterns
- Document when deliberation is appropriate

### Phase 4: Trust But Verify
- Change "DO NOT validate" to "trust by default, verify when needed"
- Add validation patterns for error recovery
- Make validation non-blocking

## Example Refactored Prompt

```typescript
export const SYSTEM_PROMPT = `
You are the Project Palindrome agent. Use Hybrid RAG context and approved tools.

**Core Principles:**
- Prefer direct answers when context is sufficient
- Default to single-pass planning for efficiency
- Allow multi-step deliberation for compound requests, error recovery, or dependency chains
- Trust action layer validation by default, but verify when actions fail or state is uncertain

**Tool Selection:**
- action: Execute infrastructure automation (discover available actions from tool schema)
- twin_query: Query digital twin for infrastructure state (prefer before live API calls)
- proxmox_readonly: Real-time Proxmox metrics (only when twin data is missing/stale)
- [other tools...]

**Action Tool Usage:**
- Actions are organized by domain: compute.*, network.*, services.*
- Action tool schema provides examples and parameter shapes dynamically
- For compound requests (e.g., "install X and configure Y"), execute sequentially
- If an action fails, you may validate state or try alternative approaches
- Action layer handles validation, but you can sanity-check results

**Query vs Action:**
- Action intents (create, install, configure, destroy) → use action tool
- Query intents (list, show, describe, what) → use twin_query or readonly tools
- Intent detection routes automatically, but you can override if needed

**Error Handling:**
- If action fails, check error message for guidance
- You may query twin_query to verify state if action result is unclear
- For recovery, you can retry with adjusted parameters or try alternative actions
`.trim();
```

## Benefits

1. **Maintainable**: Action names come from registry, not hardcoded
2. **Flexible**: Allows multi-step when needed, single-pass by default
3. **Efficient**: ~70% reduction in prompt length
4. **Resilient**: Can validate/recover when actions fail

## Migration Strategy

1. Keep current prompt as fallback
2. Implement refactored prompt alongside
3. A/B test with real queries
4. Monitor for regressions
5. Fully migrate once validated

