# Intent Classification & Routing Architecture

## Overview

Clean separation of concerns: **Classification → Routing → Execution**

Language variance is treated as a **feature**, not an error. No typo detection, no hard-coded patterns.

## Architecture

```
User Input
    ↓
Intent Classifier (Probabilistic)
    ├─ Semantic similarity to intent archetypes
    ├─ Returns: IntentType + Confidence + Metadata
    └─ Handles: QUERY, ACTION, CHAT, CLARIFICATION
    ↓
Intent Router
    ├─ Routes based on classified intent
    ├─ Tries domain-specific handlers first
    └─ Falls back to LLM reasoning if needed
    ↓
Execution Handlers
    ├─ Direct handlers (fast path)
    ├─ LLM reasoning (complex queries)
    └─ Clarification (ambiguous input)
```

## Components

### 1. Intent Classifier (`intent-classifier.ts`)

**Purpose**: Probabilistic classification using semantic similarity

**Key Features**:
- Uses Jaccard similarity + structural bonuses
- Intent archetypes capture semantic meaning, not exact wording
- Returns confidence scores
- Extracts metadata (domain, action type, query type)

**Example**:
```typescript
classifyIntent("whats the temp of nodes")
// Returns: { type: "QUERY", confidence: 0.85, metadata: { domain: "metrics", queryType: "temperature" } }
```

**Why it works**:
- "whats" → "what's" → matches QUERY archetypes semantically
- "temp" → "temperature" → matches metrics domain
- "nodes" → plural form naturally handled
- No typo detection needed - similarity handles variance

### 2. Intent Router (`intent-router.ts`)

**Purpose**: Route classified intents to appropriate handlers

**Routing Logic**:
- **ACTION** → Try `detectActionIntent()` → Route to action executor or LLM
- **QUERY** → Try domain-specific detectors → Route to query handlers or LLM
- **CHAT** → Route to LLM reasoning
- **CLARIFICATION** → Ask user for clarification

**Example**:
```typescript
routeIntent("whats the temp", { type: "QUERY", domain: "metrics" })
// Returns: { route: "llm_reasoning", confidence: 0.85 }
// LLM will use twin_query or proxmox_readonly tools
```

### 3. Integration with Runner

Replace the old clarification check with:

```typescript
import { classifyAndRoute } from "./reasoning/intent-router";

// In runAgent():
const { classification, routing } = classifyAndRoute(userInput);

if (routing.route === "clarification") {
  // Handle ambiguous input
  return { text: "Could you clarify what you'd like to do?" };
}

if (routing.route === "direct_handler") {
  // Fast path: use specific handler
  return await executeDirectHandler(routing.handler, routing.intent);
}

// Otherwise: route to LLM reasoning (existing flow)
```

## Benefits

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

### ✅ Extensible
- Can upgrade to embeddings (OpenAI, local model) without changing interface
- Can add new domains without touching existing code
- Can add new handlers without changing classifier

## Future Enhancements

1. **Embeddings-based similarity**: Replace Jaccard with embeddings for better semantic understanding
2. **Learning from feedback**: Track which classifications were correct, improve archetypes
3. **Context-aware classification**: Use conversation history to improve intent detection
4. **Multi-intent detection**: Handle compound requests ("install nginx and configure firewall")

## Migration Path

1. **Phase 1**: Add new classifier alongside old system (feature flag)
2. **Phase 2**: Route simple cases through new system, complex through old
3. **Phase 3**: Fully migrate, remove old clarification logic
4. **Phase 4**: Enhance with embeddings if needed

