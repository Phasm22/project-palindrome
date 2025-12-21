# Intent Classification Refactor Summary

## Problem

The original clarification system treated **language variance as errors**:
- "whats" → typo for "list"
- "of" → typo for "firewall"  
- "nodes" → typo for "node"

This was **fragile, non-scalable, and hid a design smell**.

## Solution

A **probabilistic intent classification pipeline** that treats language variance as a feature:

```
User Input → Intent Classifier → Intent Router → Execution Handler
```

## Architecture

### 1. Intent Classifier (`intent-classifier.ts`)

**Semantic similarity-based classification**:
- Uses Jaccard similarity + structural bonuses
- Intent archetypes capture semantic meaning, not exact wording
- Returns: `IntentType` (QUERY, ACTION, CHAT, CLARIFICATION) + confidence + metadata

**Key Insight**: "whats the temperature" semantically matches QUERY archetypes, regardless of spelling.

### 2. Intent Router (`intent-router.ts`)

**Routes classified intents**:
- ACTION → Try action intent detection → Route to action executor or LLM
- QUERY → Try domain-specific detectors → Route to query handlers or LLM
- CHAT → Route to LLM reasoning
- CLARIFICATION → Ask for clarification

### 3. Integration

Replace old clarification check:
```typescript
// OLD (fragile)
const clarificationResult = analyzeInput(userInput);
if (clarificationResult.needsClarification) {
  return { text: formatClarificationMessage(clarificationResult) };
}

// NEW (robust)
const { classification, routing } = classifyAndRoute(userInput);
if (routing.route === "clarification") {
  return { text: generateClarificationPrompt(userInput, classification) };
}
```

## Results

### ✅ Handles Language Variance Naturally

**Test Case**: "whats the temperature of the different nodes"

**Old System**:
```
🔍 I noticed some possible typos: "whats" → "list", "of" → "firewall", "nodes" → "node"
Did you mean one of these?
```

**New System**:
```
Classification: QUERY (confidence: 0.35)
Domain: metrics
QueryType: temperature
Route: llm_reasoning
→ Proceeds to LLM with appropriate tools
```

### ✅ Scalable

- Add new intent types by adding archetypes
- No hard-coded patterns to maintain
- Works with any natural language variation

### ✅ Robust

- Semantic similarity handles typos, casual spelling, synonyms
- Confidence scores indicate when clarification is needed
- Graceful fallback to LLM reasoning

### ✅ Maintainable

- Clear separation: classification → routing → execution
- Easy to test each component independently
- No brittle pattern matching

## Files Created

1. **`intent-classifier.ts`**: Probabilistic intent classification
2. **`intent-router.ts`**: Intent routing logic
3. **`intent-integration-example.ts`**: Example integration code
4. **`intent-classifier.test.ts`**: Test cases demonstrating language variance handling
5. **`INTENT_ARCHITECTURE.md`**: Architecture documentation

## Next Steps

### Phase 1: Integration (Recommended)
1. Add feature flag to enable new classifier
2. Route simple cases through new system
3. Monitor confidence scores and adjust archetypes

### Phase 2: Enhancement
1. Upgrade to embeddings-based similarity (OpenAI, local model)
2. Add learning from feedback
3. Support multi-intent detection

### Phase 3: Migration
1. Fully migrate to new system
2. Remove old clarification logic
3. Update documentation

## Example Usage

```typescript
import { classifyAndRoute } from "./reasoning/intent-router";

const { classification, routing } = classifyAndRoute("whats the temp of nodes");

console.log(classification);
// {
//   type: "QUERY",
//   confidence: 0.35,
//   metadata: { domain: "metrics", queryType: "temperature" }
// }

console.log(routing);
// {
//   route: "llm_reasoning",
//   confidence: 0.35
// }
```

## Key Benefits

1. **No typo detection needed** - semantic similarity handles variance
2. **Confidence scores** - know when to ask for clarification
3. **Extensible** - easy to add new intents, domains, handlers
4. **Testable** - each component can be tested independently
5. **Future-proof** - can upgrade to embeddings without changing interface

