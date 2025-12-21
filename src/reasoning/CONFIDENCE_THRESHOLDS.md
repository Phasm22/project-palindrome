# Confidence Threshold System

## Overview

The confidence threshold system is **load-bearing** - it determines routing decisions based on how confident the intent classifier is about the user's intent. Different domains and action types have different thresholds.

## Confidence Levels

| Level | Range | Behavior |
|-------|-------|----------|
| **TOO_LOW** | < 0.30 | Clarification needed (too ambiguous) |
| **MEDIUM** | 0.30-0.55 | Route to LLM with validation flag (caution) |
| **GOOD** | 0.55-0.80 | Normal routing (direct handler or LLM based on complexity) |
| **HIGH** | >= 0.80 | Route to direct handler (high confidence) |

## Domain-Specific Thresholds

### Metrics Queries
- **Threshold**: 0.15 (very permissive)
- **Rationale**: Metrics queries are safe and informational. Low confidence is acceptable.
- **Example**: "what's the temp", "show me status", "how much memory"

### Regular Queries
- **Threshold**: 0.30 (permissive)
- **Rationale**: Informational queries are safe. Moderate confidence is acceptable.
- **Example**: "list all vms", "show firewall rules", "describe the cluster"

### Regular Actions (Non-Destructive)
- **Threshold**: 0.50 (moderate)
- **Rationale**: Non-destructive actions (create, install, configure) need moderate confidence.
- **Example**: "create a vm", "install nginx", "configure firewall"

### Destructive Actions
- **Threshold**: 0.70 (strict)
- **Rationale**: Destructive actions (destroy, delete, remove) are irreversible. High confidence required.
- **Example**: "destroy vm X", "delete container Y", "remove firewall rule"

### CHAT
- **Threshold**: 0.30 (flexible)
- **Rationale**: Conversational queries are flexible and can tolerate ambiguity.
- **Example**: "hello", "help me", "explain how this works"

## Routing Decisions

### At 0.30 Confidence

**Metrics Query** (threshold: 0.15):
- ✅ Meets threshold
- Route: `llm_reasoning` (safe, no validation needed)

**Regular Query** (threshold: 0.30):
- ✅ Meets threshold (exactly at threshold)
- Route: `llm_reasoning` with `requiresValidation: true` (medium confidence)

**Regular Action** (threshold: 0.50):
- ❌ Below threshold
- Route: `clarification` (needs more confidence)

**Destructive Action** (threshold: 0.70):
- ❌ Below threshold
- Route: `clarification` (needs much higher confidence)

### At 0.55 Confidence

**Metrics Query**:
- ✅ Meets threshold
- Route: `llm_reasoning` (safe)

**Regular Query**:
- ✅ Meets threshold
- Route: `llm_reasoning` (good confidence, no validation needed)

**Regular Action**:
- ✅ Meets threshold
- Route: `llm_reasoning` (good confidence, may route to direct handler if parsed)

**Destructive Action**:
- ❌ Below threshold
- Route: `clarification` (still needs higher confidence)

### At 0.80 Confidence

**Metrics Query**:
- ✅ Meets threshold
- Route: `llm_reasoning` (safe, high confidence)

**Regular Query**:
- ✅ Meets threshold
- Route: `direct_handler` if domain-specific handler available, else `llm_reasoning` (high confidence)

**Regular Action**:
- ✅ Meets threshold
- Route: `direct_handler` if action parsed, else `llm_reasoning` (high confidence)

**Destructive Action**:
- ✅ Meets threshold
- Route: `direct_handler` if action parsed (high confidence, but still requires validation)

## Implementation

### Functions

1. **`getConfidenceThreshold(classification)`**: Returns the required threshold for a classification based on domain/action type
2. **`getConfidenceLevel(confidence)`**: Returns the confidence level (TOO_LOW, MEDIUM, GOOD, HIGH)
3. **`meetsConfidenceThreshold(classification)`**: Checks if confidence meets the required threshold
4. **`isDestructiveAction(actionType)`**: Checks if an action type is destructive

### Routing Logic

```typescript
// Check threshold first
if (!meetsConfidenceThreshold(classification)) {
  return { route: "clarification", reason: "Confidence too low" };
}

// Route based on confidence level
switch (getConfidenceLevel(confidence)) {
  case ConfidenceLevel.MEDIUM:
    return routeWithValidation(userInput, classification, true);
  case ConfidenceLevel.GOOD:
  case ConfidenceLevel.HIGH:
    return routeWithValidation(userInput, classification, false);
}
```

## Safety Guarantees

1. **Destructive actions** always require >= 0.70 confidence
2. **Medium confidence** (0.30-0.55) actions route to LLM with `requiresValidation: true`
3. **Metrics queries** can proceed with as low as 0.15 confidence (safe, informational)
4. **High confidence** (>= 0.80) queries can route to direct handlers when available

## Examples

### Example 1: Low Confidence Metrics Query
```
Input: "temp"
Classification: { type: "QUERY", confidence: 0.25, domain: "metrics" }
Threshold: 0.15
Decision: ✅ Meets threshold → Route to LLM (safe)
```

### Example 2: Medium Confidence Destructive Action
```
Input: "destroy vm test"
Classification: { type: "ACTION", confidence: 0.65, actionType: "destroy" }
Threshold: 0.70
Decision: ❌ Below threshold → Clarification needed
```

### Example 3: High Confidence Destructive Action
```
Input: "delete the vm named test-server"
Classification: { type: "ACTION", confidence: 0.85, actionType: "destroy" }
Threshold: 0.70
Decision: ✅ Meets threshold → Route to direct handler (high confidence)
```

### Example 4: Medium Confidence Regular Action
```
Input: "install nginx"
Classification: { type: "ACTION", confidence: 0.45, actionType: "install" }
Threshold: 0.50
Decision: ❌ Below threshold → Clarification needed
```

## Notes

- Thresholds are encoded in the **router**, not the system prompt (Constitution)
- The system prompt only contains principles, not specific thresholds
- Thresholds can be adjusted based on real-world performance
- The `requiresValidation` flag signals to the runtime that extra validation may be needed

