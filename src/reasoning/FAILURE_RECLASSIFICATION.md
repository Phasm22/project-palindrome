# Failure-Aware Intent Reclassification

> **Verified live 2026-07-22.** `reclassifyIntentWithContext` and `FailureTracker`
> remain implemented in `failure-reclassification.ts` and are invoked by
> `agent/handlers/handle-execute.ts`. This is a companion to
> `CLASSIFICATION_STANDARDS.md`, not part of the pre-LLM documentation archive.

## Overview

When a tool execution fails, we **don't retry blindly**. Instead, we reclassify the intent with context (error message, partial state) to make better decisions about next steps.

This prevents retry loops:
- ❌ `failed → retry → failed → retry` (blind retry loop)

Instead:
- ✅ `failed → reclassify with context → new approach → success/failure`

## Architecture

### Components

1. **`reclassifyIntentWithContext()`**: Reclassifies intent with failure context
2. **`FailureTracker`**: Tracks failure attempts to prevent loops
3. **Integration in `runner.ts`**: Uses reclassification on tool failures

### Flow

```
Tool Execution Fails
    ↓
Record Failure Context
    ↓
Reclassify Intent with Context
    ├─ Error message
    ├─ Tool name and parameters
    ├─ Partial state (if any)
    ├─ Attempt number
    └─ Previous attempts
    ↓
Determine Next Action
    ├─ Should retry? (based on error type, attempts, reclassification)
    ├─ Suggested action (based on error pattern)
    └─ Add context to LLM for next step
```

## Failure Context

When a tool fails, we capture:

```typescript
{
  error: string;                    // Error message
  toolName: string;                 // Which tool failed
  parameters?: Record<string, any>; // What parameters were attempted
  partialState?: Record<string, any>; // Any partial results
  attemptNumber: number;            // Current attempt number
  previousAttempts?: Array<{        // History of previous failures
    toolName: string;
    error: string;
    attemptNumber: number;
  }>;
}
```

## Reclassification Process

### 1. Enrich Input with Context

The original user input is enriched with failure context:

```
Original request: install nginx on test-vm
Previous attempt failed: VM not found
Failed tool: action
This is attempt 2
Previous attempts: Attempt 1: action failed with "VM not found"
Attempted parameters: action=services.install_nginx, vmName=test-vm
```

### 2. Reclassify

The enriched input is reclassified using the standard intent classifier, which now has context about:
- What was attempted
- Why it failed
- What partial state exists

### 3. Determine Next Action

Based on reclassification and error analysis:

- **Should retry?**
  - ✅ Yes if: Transient error (timeout, network, rate limit) AND attempts < 3
  - ❌ No if: Fundamental error (not found, invalid, forbidden) OR attempts >= 3

- **Suggested action?**
  - "Try finding the VM by name using twin_query find_vm_by_name first"
  - "Check if the required permissions are available"
  - "Validate the current state using twin_query before retrying"

## Retry Logic

### Retry Conditions

**Will retry if:**
- Error is transient (timeout, connection, network, rate limit)
- Attempts < 3
- Reclassification doesn't suggest clarification

**Won't retry if:**
- Error is fundamental (not found, invalid, forbidden, unauthorized)
- Attempts >= 3
- Reclassification suggests clarification is needed

### Error Classification

**Transient errors** (retryable):
- `timeout`
- `connection`
- `network`
- `temporary`
- `rate limit`
- `busy`
- `unavailable`

**Fundamental errors** (not retryable):
- `not found`
- `does not exist`
- `invalid`
- `forbidden`
- `unauthorized`
- `permission denied`
- `authentication failed`
- `not supported`
- `not available`

## Integration in Runner

When a tool execution fails in `runner.ts`:

1. **Record failure** in `FailureTracker`
2. **Reclassify** with context
3. **Log decision** in reasoning step
4. **Add context** to LLM conversation:
   - If should retry: Add suggested action
   - If shouldn't retry: Add explanation and ask for different approach

### Example Flow

```
User: "install nginx on test-vm"
    ↓
Action tool: services.install_nginx
    ↓
Error: "VM not found"
    ↓
Reclassify with context:
  - Error: "VM not found"
  - Tool: "action"
  - Parameters: {action: "services.install_nginx", vmName: "test-vm"}
    ↓
Reclassification result:
  - Should retry: false (fundamental error)
  - Suggested action: "Try finding the VM by name using twin_query find_vm_by_name first"
    ↓
Add to context: "Previous attempt failed: VM not found. Try finding the VM by name using twin_query find_vm_by_name first"
    ↓
LLM makes new tool call: twin_query find_vm_by_name
```

## Failure Tracking

The `FailureTracker` class:
- Tracks failures per input (normalized key)
- Prevents retry loops (max 3 attempts)
- Clears history on success
- Provides failure history for context

### Tracking Key

Failures are tracked by normalized input:
- `"install nginx"` → key: `"install nginx"`
- `"Install nginx"` → key: `"install nginx"` (same key)

This prevents tracking the same request multiple times with different casing.

## Confidence Monotonicity

**CRITICAL SAFETY FEATURE**: Confidence is **monotonic** across retries - it cannot increase unless there's genuinely new evidence.

### Why This Matters

Without monotonicity, retries could "ratchet" into unsafe zones:
- Attempt 1: Confidence 0.45 (below threshold, needs clarification)
- Attempt 2: Confidence 0.65 (artificially higher due to enriched context)
- Attempt 3: Confidence 0.80 (ratcheted into unsafe zone, executes destructively)

### How It Works

1. **Store original classification** when first classifying the input
2. **Reclassify with context** when failure occurs
3. **Cap confidence** to original if no genuinely new evidence exists
4. **Allow increase** only if there's genuinely new evidence

### What Counts as "New Evidence"

**✅ Genuinely new evidence** (confidence can increase):
- Partial state that confirms entity exists (e.g., "VM exists but is stopped")
- Partial results that validate the intent
- State information that wasn't available before
- Errors that reveal state (e.g., "VM exists but is already running")

**❌ NOT new evidence** (confidence stays capped):
- Error messages alone (they don't confirm intent)
- Retry attempt numbers (they don't add information)
- Parameter listings (they're just what we tried)
- Enriched context text (can artificially boost confidence)

### Example

```
Original: "install nginx" → Confidence: 0.45
    ↓
Failure: "VM not found"
    ↓
Reclassify: Confidence would be 0.65 (enriched context)
    ↓
Check: No genuinely new evidence
    ↓
Result: Confidence capped at 0.45 ✅ (prevents ratcheting)
```

vs.

```
Original: "install nginx" → Confidence: 0.45
    ↓
Failure: "VM exists but is stopped"
    ↓
Reclassify: Confidence would be 0.65
    ↓
Check: Error reveals VM exists (new evidence!)
    ↓
Result: Confidence allowed to increase to 0.65 ✅ (genuine evidence)
```

## Benefits

1. **Prevents retry loops**: Stops after 3 attempts or on fundamental errors
2. **Context-aware decisions**: Uses error context to make better choices
3. **Suggests alternatives**: Provides actionable suggestions based on error patterns
4. **Tracks history**: Remembers previous attempts to avoid repeating mistakes
5. **Clear reasoning**: Logs decisions in reasoning steps for debugging
6. **Monotonic confidence**: Prevents ratcheting into unsafe zones

## Examples

### Example 1: Transient Error (Retry)

```
Attempt 1: action tool fails with "Connection timeout"
→ Reclassify: Should retry = true (transient error)
→ Add context: "Previous attempt failed: Connection timeout. Retrying..."
→ LLM retries with same action
```

### Example 2: Fundamental Error (No Retry)

```
Attempt 1: action tool fails with "VM not found"
→ Reclassify: Should retry = false (fundamental error)
→ Suggested action: "Try finding the VM by name using twin_query find_vm_by_name first"
→ Add context: "Previous attempt failed: VM not found. Try finding the VM by name..."
→ LLM makes new tool call: twin_query find_vm_by_name
```

### Example 3: Max Attempts Reached

```
Attempt 1: action tool fails
Attempt 2: action tool fails
Attempt 3: action tool fails
→ Reclassify: Should retry = false (max attempts reached)
→ Add context: "Tool execution failed after 3 attempts. Please try a different approach."
→ LLM stops retrying and asks for clarification
```

## Future Enhancements

1. **Error pattern learning**: Learn from successful recovery patterns
2. **State validation**: Automatically validate state before retrying
3. **Alternative action suggestions**: Suggest specific alternative actions based on error
4. **Confidence adjustment**: Adjust confidence scores based on failure history
