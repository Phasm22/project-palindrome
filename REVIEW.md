# Project Palindrome — Architecture Review & Ideation
**Date:** 2026-03-03
**Scope:** Code Review · Bottleneck Discovery · Next-Iteration Ideation
**Reviewer role:** Senior Principal AI Engineer / Systems Architect
**Method:** Static analysis via subagents + CLI diagnostic audit across ~180 source files

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [What the System Actually Does Well](#2-what-the-system-actually-does-well)
3. [The Core Diagnosis: Linear Pipeline vs. State Machine](#3-the-core-diagnosis-linear-pipeline-vs-state-machine)
4. [Bottleneck 1 — The 3,550-Line Monolith](#4-bottleneck-1--the-3550-line-monolith-agentrunner)
5. [Bottleneck 2 — Intent Routing Has Zero LLM Involvement](#5-bottleneck-2--intent-routing-has-zero-llm-involvement)
6. [Bottleneck 3 — Data Integrity & Non-Deterministic Outputs](#6-bottleneck-3--data-integrity--non-deterministic-outputs)
7. [Bottleneck 4 — The Action Layer Paradox](#7-bottleneck-4--the-action-layer-paradox)
8. [Bottleneck 5 — Conversation State Is a Flat Array](#8-bottleneck-5--conversation-state-is-a-flat-array)
9. [UX / Product Quality Gap Analysis](#9-ux--product-quality-gap-analysis)
10. [Industry Standards Cross-Reference](#10-industry-standards-cross-reference)
11. [Tooling Gap Analysis & OSS Recommendations](#11-tooling-gap-analysis--oss-recommendations)
12. [Ideation: The Next Architecture](#12-ideation-the-next-architecture)
13. [Severity Matrix](#13-severity-matrix)

---

## 1. Executive Summary

Palindrome is a homelab infrastructure assistant with more architectural maturity than its "script-runner with a chat interface" self-description suggests. The hybrid RAG pipeline (Neo4j + Qdrant), the intent-based Terraform action layer, the observability via SSE/SQLite traces, and the twin-first reasoning approach are all solid design choices.

The problem is **structural**: the system's execution model is a **linear, single-pass pipeline** disguised as an agent. Each call to `runAgent()` is a procedural waterfall of 3,550 lines — not a composable graph of reasoning nodes. The intelligence is real, but it's fused into one function rather than expressed as explicit state and transitions. The consequence:

- **Chaining feels clunky** because there is no "chain" — only `if/else` branches in a single function.
- **LLM outputs are non-deterministic** because structured output schemas are used for exactly one endpoint (`edl/extraction/extractor.ts`) out of dozens.
- **Adding a new capability requires touching multiple files** (intent detector, chain function, router, action registry, ActionTool docstring) with no generative path.
- **The UX stalls** at multi-turn tasks because conversation state is a flat `Array<{role, content}>` — the agent can't carry intermediate structured state between turns.

**The shift from "script-runner" to "dynamic orchestrator" requires one architectural primitive: an explicit, persisted, typed state machine at the conversation layer.** Everything else builds from that.

---

## 2. What the System Actually Does Well

Before cataloguing problems, this section is important: the project is not a toy, and several design decisions are ahead of the curve for a homelab project.

### ✅ Twin-First Reasoning
Preferring `twin_query` (Neo4j digital twin) over live Proxmox API reads is sound. It reduces latency, rate-limit exposure, and side effects. The live-Proxmox fallback in `create-vm.ts` (when twin is stale) is genuinely thoughtful.

### ✅ Intent-Based Provisioning — Not Predefined VMs
`create-vm.ts` has no hardcoded VM templates. It:
- Generates palindrome names dynamically from existing twin state
- Discovers datastores and bridges from the live node at provisioning time
- Selects Terraform tokens based on cluster topology at runtime
- Validates against the twin with live fallback

This is genuinely closer to TAG (Tool-Augmented Generation) than most homelab projects achieve.

### ✅ Zod Schemas at the Action Boundary
Every action (`CreateVmSchema`, `DestroyVmSchema`, `BootstrapSchema`, etc.) validates inputs with Zod before execution. Tool inputs are validated in `ActionTool.ts` via `safeParse`. This is the right boundary for schema enforcement.

### ✅ Observability Baked In
SSE event streaming, per-turn reasoning traces in SQLite (`reasoning-trace-store.ts`), tool execution history (`tool-execution-store.ts`), and a dashboard with RAG diagnostics — this is production-grade observability for a homelab system.

### ✅ Failure Reclassification
The `FailureTracker` + `reclassifyIntentWithContext()` loop in `runner.ts` shows the intent to recover from errors gracefully rather than crashing or looping blindly. The direction is right even if the implementation has a loop risk (detailed below).

### ✅ Hybrid RAG Fusion
Weighted fusion of vector (Qdrant, weight=0.5) + graph (Neo4j, weight=0.4) + recency (0.1) with score thresholds is a well-designed hybrid retrieval strategy. The 30-second cache for non-action queries is a sensible optimization.

---

## 3. The Core Diagnosis: Linear Pipeline vs. State Machine

This is the foundational issue from which most other problems derive.

### What exists today

```
runAgent(userInput, options)
  │
  ├─ Parse confirmation state           ← is this a CONFIRM reply?
  ├─ Parse clarification state          ← is this answering a clarification?
  ├─ Classify intent (Jaccard)          ← QUERY | ACTION | CLARIFICATION | CHAT...
  ├─ Detect domain intent (regex)       ← compute | firewall | network | exposure
  ├─ Try domain-specific chain          ← Twin query → format string → return early
  │    └─ If chain fails: fall through silently
  ├─ Fetch RAG context (if eligible)
  ├─ Build system prompt
  ├─ Enter LLM loop (MAX_STEPS=5)
  │    └─ LLM decides tool calls
  │    └─ Execute tools (ACL, risk check, dry-run)
  │    └─ Handle failure (reclassify, retry)
  │    └─ Check confirmation (abort to AWAITING_CONFIRMATION)
  │    └─ Check clarification (abort to NEED_CLARIFICATION)
  └─ Return AgentResponse
```

This is a **state machine implemented as procedural code**. Every "state" (IDLE, AWAITING\_CONFIRMATION, NEED\_CLARIFICATION, EXECUTING, RECLASSIFYING) is expressed as an `if/else` branch inside one function. There are no explicit state objects, no transition graph, and no way to observe which state you're in without reading runtime variables.

### What a state machine would look like

```
States: IDLE → CLASSIFYING → RETRIEVING → PLANNING → EXECUTING → CONFIRMING → CLARIFYING → RESPONDING

Transitions:
  CLASSIFYING  ──[domain intent found]──→  CHAIN_EXECUTING (no LLM needed)
  CLASSIFYING  ──[action intent]──────────→ PLANNING
  CLASSIFYING  ──[ambiguous]─────────────→ CLARIFYING
  PLANNING     ──[high risk tool]─────────→ CONFIRMING
  EXECUTING    ──[tool error]──────────────→ RECLASSIFYING → PLANNING
  CONFIRMING   ──[user confirms]────────→  EXECUTING
  CONFIRMING   ──[user cancels]─────────→  IDLE
  CLARIFYING   ──[user answers]─────────→  CLASSIFYING (with context)
```

The critical difference: **state is a typed, persistent object**, not a bag of optional fields in `ConversationContext`. Transitions are explicit edges. Any state can be serialized and resumed.

### Impact on UX

A user says: *"Destroy the web server VM"*
Agent asks: *"Which VM? I found three: nginx-01, nginx-02, web-prod"*
User replies: *"web-prod"*

With the current system, the second turn enters `runAgent()` fresh. The conversation history is a flat array of `{role: "user" | "assistant", content: string}`. There is no structured carry-over of:
- The list of candidates already retrieved
- The fact that a disambiguation was in progress
- The partial intent object (destroy\_vm, node=?, vmid=?)

The agent must re-classify, re-retrieve, re-plan. It may or may not correctly interpret "web-prod" as a VM name rather than a new query. This is the root cause of the "clunky chaining" observation.

**LangGraph reference:** A `StateGraph` with typed `AgentState` would persist `{ intent, candidates, pendingToolCall, confirmationId }` across turns. The second message would enter the `CLARIFYING → EXECUTING` edge with full context intact.

---

## 4. Bottleneck 1 — The 3,550-Line Monolith (`agent/runner.ts`)

### Scale of the problem

| Metric | Value |
|--------|-------|
| Total lines | 3,550 |
| Single exported function | `runAgent()` |
| Responsibilities | 9+ distinct concerns |
| Internal state variables per call | ~35 |
| `if/else` branches for state | ~60 |

The nine concerns fused into one function:
1. Confirmation flow parsing
2. Clarification flow parsing
3. Intent classification (delegates to classifier)
4. Domain-specific chain routing (compute/firewall/network/exposure)
5. RAG eligibility and injection
6. System prompt assembly
7. LLM loop with MAX\_STEPS
8. Tool execution (ACL checks, dry-runs, deduplication, parallelization)
9. Failure tracking and reclassification

### Key anti-patterns

**Silent chain fallthrough** — if a domain chain returns null (e.g., node not in twin), execution falls through to the LLM with no signal:
```typescript
// runner.ts ~line 2303
const twinAnswer = await executeComputeIntent(computeIntent, tools, session);
if (twinAnswer) {
  return { text: formattedAnswer }; // early exit
}
// Falls through to LLM if twinAnswer is null — no log, no context
```
The LLM has no idea a chain was attempted and failed. It starts from scratch, potentially returning a different answer format.

**Hardcoded parallelization** — parallel SSH execution only triggers for a single pattern:
```typescript
// runner.ts ~line 2679
const canParallelize = isAllNodesQuery &&
  toolCalls.length > 1 &&
  toolCalls.every(tc => tc.function?.name === "ssh_execute" && args.command?.includes("sensors"));
```
Any other read-only parallel operation (e.g., twin_query across multiple VMs) is sequential by accident, not by design.

**Failure reclassification loop risk** — on tool error, `reclassifyIntentWithContext()` is called, which modifies the agent context (adds messages), which triggers another LLM call. If the reclassified intent triggers the same failing tool, you can burn through `MAX_STEPS` on retries of the same failure.

**Mutable context exposure** — `AgentContext.getMessages()` returns the raw array, and callers push directly into it:
```typescript
// runner.ts line 2676
context.getMessages().push(assistantMsg);
```
There is no `addMessage()` method, no validation, no event. This is a source of subtle bugs if messages are added out of order or with incorrect structure.

### Recommendation

Split `runAgent()` into composable handlers keyed to conversation state transitions. Each handler receives typed state, does one job, and returns updated state. The router decides which handler to invoke. This is the LangGraph/XState pattern applied at the conversation level.

---

## 5. Bottleneck 2 — Intent Routing Has Zero LLM Involvement

This is the most surprising finding of the review.

### The intent classifier does not use an LLM

`src/reasoning/intent-classifier.ts` (611 lines) routes every user query using:
1. **Jaccard similarity** with hardcoded archetype strings
2. **Regex pattern matching** for domain detection
3. **Fixed confidence thresholds** (0.3, 0.1) for ambiguity detection

```typescript
// intent-classifier.ts — the "semantic similarity" engine
function semanticSimilarity(query: string, archetype: string): number {
  const qTokens = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
  const aTokens = new Set(archetype.toLowerCase().split(/\W+/).filter(Boolean));
  const intersection = [...qTokens].filter(x => aTokens.has(x)).length;
  const union = new Set([...qTokens, ...aTokens]).size;
  return union === 0 ? 0 : intersection / union;  // Jaccard coefficient
}
```

Domain-specific detectors (`detectFirewallIntent`, `detectNetworkIntent`, `detectComputeIntent`) are keyword-first with early returns:

```typescript
// detectFirewallIntent.ts
if (!hasFirewallKeywords) return null;
// ...
return { type: "list_rules" }; // fallback for any firewall keyword match
```

### Why this matters

**The classifier is brittle** because it can't understand intent, only vocabulary overlap. Consequences:

- `"Can you check if my ssh service is exposed to wan?"` → might not trigger firewall intent (no keyword "firewall", "rule", "allow") → goes to LLM with no pre-fetched context
- `"What's running on yang?"` with a typo → Jaccard score drops, classified as CHAT\_REASONING → no twin query → LLM hallucinates
- `"Temperature on all nodes and which ones have less than 8 cores"` → ambiguous domain (compute + real-time metric) → first-match-wins → potentially wrong chain
- First-match-wins domain detection at lines 350-355: `"vm network firewall"` → classified as `compute`, ignores firewall context

### Hardcoded infrastructure knowledge

Both the classifier and chains embed infrastructure-specific constants that should be in configuration or the twin:

```typescript
// compute-intents.ts
const KNOWN_NODE_NAMES = new Set(["yang", "yin", "proxbig", "pve1", "pve2"]);

// compute.ts — case-sensitive node name normalization
const finalNodeName = normalizedNode === "Proxbig" ? "proxBig" :
                     normalizedNode === "Yang" ? "YANG" :
                     normalizedNode === "Yin" ? "yin" : normalizedNode;
```

This means adding a new node requires code changes, not configuration. The twin knows all nodes; the classifier doesn't consult it.

### The "zero LLM in chains" architecture choice — trade-offs

The twin-first fast-path approach (classify → chain → string, no LLM) has real benefits: speed, determinism, cost. It's a valid pattern for well-defined query types.

The problem is **rigidity without escape velocity**: the system has no mechanism to upgrade a failing regex match to an LLM interpretation. When the keyword-based classifier is wrong, there is no self-correction path.

**DSPy reference:** A DSPy `Signature` for intent classification would replace the hardcoded Jaccard with a learned few-shot module. The same module would handle spelling variations, synonyms, and multi-domain queries without hand-tuned thresholds.

**Instructor reference:** A simple `client.chat.completions.create()` call with `response_model=IntentClassification` (a Pydantic/Zod schema) would give structured, validated intent objects with built-in retry on parse failure — at the cost of one LLM call per query. Whether that trade-off is worth it depends on query volume; for a homelab, it almost certainly is.

---

## 6. Bottleneck 3 — Data Integrity & Non-Deterministic Outputs

### Structured output usage: one endpoint out of ~180 files

A codebase-wide audit found exactly **one** `response_format` usage:

```typescript
// src/pce/edl/extraction/extractor.ts:78
response_format: { type: "json_object" },
```

The main agent LLM loop uses `tool_choice: "auto"` with no `response_format`. This means the LLM can produce:
- Pure text (no tool call)
- A mix of text and tool calls
- Tool calls with arguments that fail `JSON.parse()` silently
- Responses that don't match the expected format the downstream formatter assumes

### `JSON.parse()` without schema validation is endemic

From the diagnostic audit, `JSON.parse()` appears in 35+ locations across the codebase with no schema validation wrapper. Representative examples:

```typescript
// runner.ts:2848 — tool argument parsing in the hot path
parsedArgs = fnCall.arguments ? JSON.parse(fnCall.arguments) : {};
// No catch, no validation. If LLM produces malformed JSON: silent empty args.

// tools/NextStepsTool.ts:66
const parsedJson = JSON.parse(content);
// No schema check — any JSON shape is accepted

// twin/api/twin-query-service.ts:1528
const ifaceData = JSON.parse(record.get("interfaceData") || "{}");
// Falls back to empty object — data loss silent
```

**The action layer is the exception**: `ActionTool.ts` calls `actionDef.schema.parse(actionParams)` (Zod strict parse) before execution. This is the right pattern and should be universal.

### Canonical entity list format is fragile

`src/agent/canonical-response-format.ts` defines a pipe-delimited format for entity lists:
```
Section Title:
- entity-name | key1=value1 | key2=value2
```

The parser (lines 89-108) has multiple assumptions:
- Title must appear before the first entity line (fails if LLM orders them differently)
- Attribute values containing `|` or `=` break parsing (no escaping)
- Trailing colons on title are stripped — but what if an entity name ends with `:`?

This is used as the canonical output contract for the dashboard. Any LLM response that doesn't perfectly match this format renders incorrectly.

### Response formatter has multiple skip heuristics and is invoked from multiple branches

`src/agent/response-formatter.ts` is bypassed in several conditions that suppress formatting entirely:

```typescript
// response-formatter.ts:591-593
if (!mode) return rawText; // formatting skipped when mode is absent

// response-formatter.ts:600-613 — skip heuristics based on content shape
if (text.length < MIN_FORMAT_LENGTH) return text;
if (SKIP_PHRASES.some(p => text.startsWith(p))) return text;
if (isErrorResponse(text)) return text;
```

The formatter is also invoked from **five distinct branches** in `runner.ts` (lines 2182-2187, 2230-2235, 2264-2269, 2314-2319, 3376-3381), each covering a different early-return path. Each branch can produce a different response shape.

Compounding this, RAG answers are **regex-mutated before reaching the formatter**:
```typescript
// runner.ts:432-507 and 1686-1697
// Regex stripping of arbitrary answer text before formatting
```

**The dashboard absorbs this inconsistency** by implementing its own 480-line heuristic parser (`formatAgentResponse` at `dashboard/js/chat.js:592-1071`) that attempts to reverse-engineer structure from free-form text. This is the consequence of having no typed response contract: the frontend must infer shape from prose.

**Impact:** The same user intent can produce materially different visual output depending on which runner branch exits and whether the formatter fires. The UI is rendering inferences, not facts.

### The `tool_choice: "auto"` problem

With `tool_choice: "auto"`, the LLM can choose not to call any tool and return a text response instead. The system has several hardcoded overrides for this:

```typescript
// runner.ts:2647
request.tool_choice = (isRealTimeMetricQuery && !hasRealTimeMetricData) ? "required" : "auto";
```

`required` is used when `isRealTimeMetricQuery` is true — detected by regex matching "uptime", "memory", "temp", etc. This means:
- "What's the CPU usage?" → `tool_choice: "required"` ✓
- "How much memory does the cluster have in total?" → `tool_choice: "auto"` — LLM may answer from training data ✗

The system needs a principled approach to when `tool_choice: "required"` vs `"auto"` applies, not a regex list.

---

## 7. Bottleneck 4 — The Action Layer Paradox

### Current state: already intent-based, but manually registered

The claim that actions are "predefined VMs" is incorrect — `create-vm.ts` is fully dynamic. The real bottleneck is different: **every capability requires manual code changes to four distinct places**.

To add a new action (e.g., `network.create_vlan`):
1. Write the action function in `src/actions/network/`
2. Define a Zod schema
3. Register in `src/actions/registry.ts`
4. Update the `ActionTool.ts` `params` docstring (a giant inline string that the LLM reads for examples)

The docstring is the critical gap — it's not auto-generated from the registry:

```typescript
// ActionTool.ts — the LLM's guide to available actions
params: z.any().describe(
  "Action parameters as an object. " +
  "For compute.create_vm: {name?: string, node: string, cores?: number, ...}. " +
  "For compute.destroy_vm: {name?: string, vmId?: number, ...}. " +
  // ... 200+ more characters of manually maintained docs
)
```

If the docstring is stale or incomplete, the LLM doesn't know about available actions. **The action registry IS the source of truth; the LLM's knowledge of it should be derived at runtime, not hardcoded.**

### Shell-string command assembly in infra runners

Terraform and Ansible commands are constructed by string concatenation rather than argv arrays:

```typescript
// src/actions/helpers/terraform-runner.ts:534-541
const cmd = `terraform ${subcommand} ${varFlags.join(" ")} ${extraFlags}`;

// src/actions/helpers/ansible-runner.ts:86-92, 161-167
const cmd = `ansible-playbook ${playbook} -i ${inventory} ${extraArgs}`;
```

String assembly is fragile under unexpected argument values: a node name containing spaces, a password with special shell characters, or an extra-vars value with quotes will silently corrupt or fail the command. The fix is `spawn(binary, argv[])` with arguments passed as a typed array — no shell interpretation, no quoting/escaping edge cases.

### The composability gap

The bigger gap is **action composition**: can the system execute "create a VM, bootstrap it, configure the firewall, and add a DNS record" as a single intent?

Currently: no. Each action is a discrete tool call. The LLM might chain them in a multi-step run (MAX\_STEPS=5), but:
- There's no "plan before execute" step
- If step 2 fails, there's no rollback of step 1
- The LLM doesn't know which actions are safe to parallelize vs. must be sequential

**LangGraph reference:** A `CompiledGraph` with nodes for each action domain would support explicit sequencing, conditional branching (if VM creation fails, don't attempt bootstrap), and parallel execution where safe.

### What "intent-based provisioning" looks like at the next level

Today: `"Create a VM on yang with 4 cores"` → LLM calls `action(compute.create_vm, {node: "yang", cores: 4})` → single action executes.

Next level: `"Spin up a web server"` → system reasons about what that means:
- What template? (query twin for available templates)
- What node? (query twin for available capacity)
- What network? (query firewall for appropriate VLAN)
- Bootstrap with which playbook? (query action capabilities)
- → Plan: create\_vm + bootstrap(nginx.yml) + create\_dns\_record

This requires a **planning node** between intent classification and execution — a step where the LLM is given the action registry, the twin state, and the user intent, and produces a multi-step plan with dependency ordering. This is the TAG (Tool-Augmented Generation) pattern applied at the planning layer.

---

## 8. Bottleneck 5 — Conversation State Is a Flat Array

### What's stored between turns

```typescript
// runner.ts:719
conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
```

This is the entire inter-turn state available to the agent. It does not include:
- Tool call history (which tools were called, with what args, with what results)
- Intermediate reasoning (what was retrieved, what was classified)
- Entity resolution cache (previously resolved "yang" → "YANG", "the web server" → vm-id 103)
- Partial intent state (for multi-turn disambiguation)
- Pending action context (for confirmation flows)

The pending action state is stored in `ConversationContext` (8 separate fields), but this is a workaround, not a design. It only works for the single pending action flow, not for general multi-turn structured state.

### `AgentContext.getMessages()` returns a mutable array

```typescript
// context.ts
class AgentContext {
  getMessages() { return this.messages; }
  // No addMessage(), no validation, no encapsulation
}

// runner.ts:2676 — caller mutates directly
context.getMessages().push(assistantMsg);
```

This is a classic encapsulation violation. Any caller can push malformed messages, push in the wrong order, or accidentally reference the same array across calls. The fact that runner.ts line 2676 has a comment saying "This is required by OpenAI API: tool messages must follow an assistant message with tool_calls" suggests the ordering constraint is known but not enforced.

### What a proper conversation state would look like

```typescript
interface ConversationState {
  sessionId: string;
  conversationId: string;
  phase: "IDLE" | "CLASSIFYING" | "CLARIFYING" | "CONFIRMING" | "EXECUTING" | "RESPONDING";

  // Structured intent (not just raw user text)
  currentIntent?: {
    type: IntentType;
    domain?: "compute" | "network" | "firewall" | "exposure";
    entities: ResolvedEntity[];  // cached entity resolution
    confidence: number;
  };

  // Multi-turn context
  pendingAction?: PendingAction;
  clarificationContext?: {
    question: string;
    candidates: any[];  // what was retrieved before asking
    partialIntent: Partial<any>;
  };

  // Message history with full tool call records
  messages: OpenAI.Messages.Message[];  // typed, includes tool_calls and tool results

  // Working memory
  lastToolResults: Map<string, any>;
  resolvedEntities: Map<string, string>;  // "yang" → "YANG", "web server" → "vm:103"
}
```

With this structure, a clarification flow is stateless: the second turn arrives, the router sees `phase === "CLARIFYING"`, and passes the full `clarificationContext` to the appropriate handler. No re-classification, no re-retrieval.

---

## 9. UX / Product Quality Gap Analysis

### The "it works" tier (current)

- Single-turn factual queries: "List all VMs on yang" → reliable, fast (twin-first)
- Simple actions: "Start VM foo-123" → reliable with confirmation flow
- RAG-backed questions: "What's the firewall rule for SSH?" → works if RAG scores above threshold

### The "it feels intelligent" tier (gap)

The gap between tiers is not primarily about the LLM — it's about **conversational continuity and graceful degradation**.

**Gap 1 — The Null Response Problem**
When a domain chain fails silently and falls through to the LLM, the LLM may produce a generic answer or ask for clarification about something it could have answered if the chain had succeeded. From the user's perspective: "why is it asking me that? it just listed all my VMs."

**Gap 2 — The Re-Classification Tax**
Multi-turn flows re-classify from scratch each turn. A user who says "destroy it" after discussing a specific VM gets a fresh classification that loses the context of "it" = vm-id 103. This is solvable only with structured inter-turn state.

**Gap 3 — The Confidence Cliff**
The intent classifier returns a confidence score, but the system treats anything above threshold as a deterministic decision. There's no "soft routing" — a 0.31 confidence compute intent gets the same treatment as a 0.95 confidence one. Users experience this as confident-but-wrong responses.

**Gap 4 — No Planning Transparency**
For multi-step actions, the user sees tool events streaming via SSE, but there's no "here's my plan" step. The LLM executes reactively (one step at a time) rather than declaratively (here's what I'll do, proceed?). For infrastructure changes, plan-before-execute is a UX requirement, not just a safety feature.

**Gap 5 — Response Format Inconsistency**
Query responses (from domain chains) are plain text strings formatted in the chain functions. LLM responses use the canonical entity list format (when the LLM adheres to it). The same query answered via chain vs. LLM looks different to the dashboard. This creates a two-class system visible to the user.

**Gap 6 — No Frontend Contract Tests**
The dashboard's `formatAgentResponse` function (`dashboard/js/chat.js:592-1071`) is the most user-visible rendering path in the system, but it has no automated tests. Backend formatter tests exist (`tests/agent/response-formatter-adaptive.test.ts`), but there are no golden snapshot tests that cover the end-to-end path from `runAgent()` output to dashboard rendering. A regression in response shape silently changes what users see with no test failure to catch it.

**Gap 7 — Twin Query Has an Incomplete Path Parsing TODO**
`src/twin/api/twin-query-service.ts:1783-1790` contains an unresolved TODO in exposure path parsing: the reachability value can be `true` with an empty path object. This means responses can imply network reachability with no route detail — confident but incomplete answers that erode user trust.

**Gap 8 — Event Bus Payload is Untyped**
`src/agent/event-bus.ts:35-40` defines the event payload as `Record<string, any>`. Every SSE subscriber and dashboard consumer accepts anything and must defensively check for fields. Versioned event schemas with runtime validation at the emit boundary would make this contract explicit and prevent silent regressions when event payloads change.

### The "feels intelligent" ingredients

Based on the architecture review, the three highest-leverage UX improvements are:

1. **Typed inter-turn state** → fixes re-classification tax and multi-turn disambiguation
2. **Plan-before-execute** for any multi-step action → transparency + safety
3. **Unified response format** generated from structured LLM output (not string formatting in chain functions) → consistent dashboard rendering

---

## 10. Industry Standards Cross-Reference

### vs. LangGraph / LangChain

| Palindrome Today | LangGraph Pattern |
|-----------------|-------------------|
| `runAgent()` — 3,550-line function | `StateGraph` with typed nodes and edges |
| `if/else` state transitions | Explicit conditional edge routing |
| `ConversationContext` — 8 pending action fields | `AgentState` — single typed state object |
| Silent chain fallthrough | Explicit edge: `chain_failed → llm_fallback` |
| `MAX_STEPS=5` loop | `recursion_limit` + explicit breakout nodes |
| Manual parallelization (SSH sensors only) | `Send()` API for dynamic parallel branching |
| No checkpointing | `MemorySaver` / `AsyncSqliteSaver` for persistence |

LangGraph's `interrupt_before` and `interrupt_after` hooks map directly to the existing confirmation flow — `AWAITING_CONFIRMATION` becomes a graph interrupt, not a manual state field.

### vs. OpenAI Structured Outputs

The system uses OpenAI function calling correctly for tool dispatch. The gap is in **response format**: the final agent response has no schema. OpenAI's `response_format: { type: "json_schema", json_schema: { ... } }` with `strict: true` would guarantee the dashboard receives a parseable response every time.

This would replace the brittle canonical entity list format with a JSON schema the LLM is constrained to follow:

```typescript
response_format: zodResponseFormat(AgentResponseSchema, "agent_response")
```

The `openai-zod-to-json-schema` package (or `@instructor-ai/instructor`) handles the conversion from Zod schema to OpenAI's JSON schema format.

### vs. DSPy

The intent classifier is the strongest DSPy candidate. The current Jaccard + regex approach would be replaced by a DSPy `Predict` module with a `Signature`:

```python
class IntentClassifier(dspy.Signature):
    """Classify the user's infrastructure query intent."""
    user_input: str = dspy.InputField()
    intent_type: Literal["QUERY", "ACTION", "CLARIFICATION", "CHAT_SOCIAL"] = dspy.OutputField()
    domain: Optional[Literal["compute", "network", "firewall", "exposure"]] = dspy.OutputField()
    entities: list[str] = dspy.OutputField(desc="Infrastructure entities mentioned")
    confidence: float = dspy.OutputField(desc="0.0 to 1.0")
```

DSPy's `BootstrapFewShot` optimizer would tune the few-shot examples against a test set (which already exists in `tests/reasoning/`). The output is a prompt that generalizes better than handwritten Jaccard similarity.

For a TypeScript project, the equivalent is using the LLM directly with a `zodResponseFormat` schema — less sophisticated than DSPy's optimization loop, but far more robust than Jaccard.

### vs. Instructor

Instructor (`@instructor-ai/instructor`) is a drop-in for `openai` that adds:
- Automatic Zod schema → JSON schema conversion
- Retry on parse failure (configurable retries)
- Streaming support for partial structured responses

```typescript
import Instructor from "@instructor-ai/instructor";
import OpenAI from "openai";

const client = Instructor({ client: new OpenAI(), mode: "TOOLS" });

const intent = await client.chat.completions.create({
  model: "gpt-4o",
  response_model: { schema: IntentSchema, name: "Intent" },
  messages: [{ role: "user", content: userInput }],
  max_retries: 3,  // auto-retry if LLM produces invalid JSON
});
```

This alone would eliminate the Jaccard classifier and give structured, validated intent objects with retry logic — in ~15 lines of code.

### vs. Open Policy Agent (OPA)

The current action ACL model uses `tool-policy.ts` with hardcoded group assignments (viewer/admin/full). This works for static environments but doesn't scale to dynamic capability enablement without code changes. OPA externalizes policy decisions into `.rego` files that can be updated without deploying application code:

```
# opnsense-writes.rego
allow {
  input.user.role == "admin"
  input.action.risk <= 2
  input.action.domain == "firewall"
  input.action.targets[_] == input.session.active_host
}
```

The critical benefit: policy becomes testable, auditable, and version-controlled separate from application logic. For a homelab, this is the difference between "I edit the code to add a new user" and "I edit a policy file."

### vs. OpenTelemetry

The project has SQLite traces and SSE event streaming. The gap is **structured, queryable telemetry** correlated across the full reasoning pipeline: from user input → classifier → chain/LLM → tool execution → response. OpenTelemetry spans would let you see exactly which classifier branch took how long, which tool failed at what latency, and where the 95th-percentile response time is being spent — without adding custom timing code. The project already has a Prometheus + Grafana stack in docker-compose; OpenTelemetry exports natively to Prometheus.

### vs. Promptfoo

There is no systematic way to detect when a code change regresses response quality. Promptfoo provides an evaluation harness that runs a test set of prompts against the agent and compares outputs. The `tests/reasoning/` directory already has representative intent fixtures; converting those to Promptfoo assertions would gate merges on quality thresholds rather than relying on manual review. This is the lowest-infrastructure path to measurable improvement per iteration.

### vs. LiteLLM

The system is hardcoded to OpenAI. All LLM calls go through the `openai` SDK directly. LiteLLM wraps 100+ providers behind the OpenAI interface, allowing:
- Fallback: if GPT-4o is rate-limited, fall back to Claude or Gemini
- Cost routing: use a cheaper model for intent classification, GPT-4o for complex planning
- Local model support: Ollama is already partially integrated in `pce/llm/local-llm-service.ts` but not in the agent path

```typescript
import LiteLLM from "litellm";
// Drop-in for openai SDK; supports model routing, fallbacks, cost tracking
```

### vs. Vercel AI SDK

**The Vercel AI SDK v5 is already installed** (`"ai": "^5.0.93"` in `package.json`) but is not used in the agent path. This is the highest-leverage quick win in the tooling gap. The SDK provides:
- `streamText()` with tool calling and built-in SSE — direct replacement for the custom `event-bus.ts` + streaming loop
- `generateObject()` with Zod schema validation — structured output without `@instructor-ai/instructor`
- `tool()` helper for defining tools with typed input/output schemas

Since it's already a dependency, replacing the custom SSE implementation in `runner.ts` and `event-bus.ts` with `streamText()` + `generateObject()` is a zero-new-dependency change that eliminates the fragile pipe-delimited canonical format and the custom event bus simultaneously.

---

## 11. Tooling Gap Analysis & OSS Recommendations

| Pain Point | Current Approach | Recommended Tool | Why |
|------------|-----------------|-----------------|-----|
| Structured LLM output | None (free-form text) | `@instructor-ai/instructor` | Auto-retry, Zod integration, minimal API change |
| Intent classification | Jaccard + regex | LLM + `zodResponseFormat` | Better generalization, handles synonyms/typos |
| Conversation state machine | Procedural if/else | LangGraph.js (`@langchain/langgraph`) | Explicit nodes, typed state, checkpointing |
| Durable multi-step workflows | In-process MAX_STEPS loop | Temporal (self-host, MIT) | Resumable across restarts, retry/compensation support |
| Model flexibility | Hardcoded OpenAI SDK | LiteLLM | Provider fallback, cost routing, no API change |
| Action documentation | Hardcoded docstrings | Auto-generated from Zod schemas | `zod-to-json-schema` → render at runtime |
| Cross-turn entity memory | Flat conversation array | LangGraph `MemorySaver` or Redis + Zod | Typed entity cache, queryable |
| Response format contract | Pipe-delimited string | Vercel AI SDK `generateObject()` (**already installed**) | Parseable, validatable, versionable, zero new deps |
| Dashboard heuristic parsing | 480-line `formatAgentResponse` in JS | Typed `AgentResponseV1` envelope | UI renders from schema; no text inference |
| Parallel execution | Hardcoded SSH+sensors only | LangGraph `Send()` API | Generic parallel branching |
| Prompt/response quality | No eval harness | Promptfoo (OSS, Apache 2.0) | Gate merges on quality thresholds; test existing fixtures |
| Policy enforcement | Hardcoded group ACL | Open Policy Agent (OPA, Apache 2.0) | Externalized, testable, auditable policy-as-code |
| Pipeline observability | SQLite traces + custom SSE | OpenTelemetry (Apache 2.0) | Structured spans across classifier→chain→tool; exports to Prometheus |
| Local LLM in agent path | Not connected | LiteLLM + Ollama backend | Already have Ollama; just need routing |
| TS-native agent framework | Custom runner | Mastra (Apache 2.0) | Memory, MCP, evals, observability primitives — TS-first |

**Priority order for adoption:**

1. **Vercel AI SDK `generateObject()` / `streamText()`** — **already installed** (`ai@5`), zero new deps. Replace the custom event bus and canonical entity list format with `generateObject(schema)`. Highest leverage per line of change.
2. **Auto-generate ActionTool docs from registry** — zero external dependency, eliminates docstring drift. Write a `generateActionDocs()` function that renders Zod schemas to description strings at tool load time.
3. **`@instructor-ai/instructor`** — structured output with auto-retry. Complements or replaces `generateObject()` for intent classification. Drop-in for OpenAI calls.
4. **Promptfoo** — no architecture changes required. Convert existing `tests/reasoning/` fixtures into eval assertions; add to CI. Immediate measurable quality baseline.
5. **LangGraph.js** — larger change, but the architectural benefits cascade everywhere. Start with a `StateGraph` for the conversation layer only; leave the existing chain functions as nodes.
6. **OPA** — externalize the ACL/risk policy from `tool-policy.ts` into `.rego` files. Enables policy testing and runtime updates without deploys.
7. **OpenTelemetry** — instrument the reasoning pipeline with spans. Already have Prometheus + Grafana; OpenTelemetry exports natively.
8. **LiteLLM** — risk mitigation. Protects against OpenAI outages and rate limits without changing application logic.
9. **`zod-to-json-schema`** — already using Zod everywhere; this unlocks `response_format: json_schema` for structured outputs across the board.
10. **Temporal** — evaluate when multi-step action complexity exceeds what in-process MAX_STEPS handles reliably (failure recovery, cross-restart resumability).

---

## 12. Ideation: The Next Architecture

This section is **high-level architectural ideation**, not an implementation plan. No code, no timelines.

### Concept: Palindrome v2 — The Conversation Graph

The core shift: replace the linear `runAgent()` pipeline with a **conversation state graph** where:
- **Nodes** are reasoning steps (Classify, Retrieve, Plan, Execute, Confirm, Clarify, Respond)
- **Edges** are typed state transitions with explicit conditions
- **State** is a persisted, typed object that flows through the graph
- **Checkpoints** happen at every node transition (resumable conversations)

```
                     ┌─────────────┐
                     │   CLASSIFY  │◄──── user input
                     └──────┬──────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         [domain]      [action]      [ambiguous]
              │             │             │
              ▼             ▼             ▼
         CHAIN_EXEC      PLAN          CLARIFY
              │             │             │
              │       ┌─────┘      ◄── user answer
              │       ▼
              │     CONFIRM?
              │       │
              │   ┌───┴───┐
              │   ▼       ▼
              │ [yes]   [no]
              │   │       │
              │   ▼       ▼
              └──►EXECUTE  IDLE
                    │
                    ▼
                 RESPOND
```

### Concept: Structured Intent Objects (not strings)

Intent classifiers should produce **typed objects**, not routing decisions. A structured intent carries everything downstream nodes need without re-querying:

```typescript
interface InfrastructureIntent {
  type: "QUERY" | "ACTION" | "DIAGNOSTIC";
  domain: "compute" | "network" | "firewall" | "exposure" | "cross_domain";
  action?: "create" | "destroy" | "start" | "stop" | "configure" | "inspect";
  entities: Array<{
    kind: "vm" | "node" | "rule" | "alias" | "subnet";
    raw: string;          // what user said: "the web server"
    resolved?: string;    // resolved id: "vm:103"
    confidence: number;
  }>;
  parameters: Record<string, unknown>;  // extracted from user input
  requiredClarifications: string[];     // what's still missing
  confidence: number;
}
```

If `requiredClarifications` is non-empty, the graph routes to CLARIFY. The CLARIFY node stores `InfrastructureIntent` (with partial data) in state, asks the question, and re-enters with the user's answer — no re-classification needed.

### Concept: Plan-Before-Execute for Multi-Step Actions

For any action that triggers more than one tool, insert a PLAN node:

1. LLM receives: current intent + action registry (auto-generated from Zod schemas) + twin state summary
2. LLM produces: an ordered list of `ActionStep[]` with dependency graph
3. System renders plan to user: "I'll create the VM, then bootstrap it, then add a DNS record. Proceed?"
4. User confirms → EXECUTE processes each step in dependency order with rollback tracking

This turns the agent's multi-step execution from a black box into a transparent, confirmable workflow.

### Concept: Entity Resolution Cache

A session-scoped `Map<string, ResolvedEntity>` that persists across turns:

- "yang" → `{ kind: "node", id: "YANG", confidence: 1.0 }`
- "the web server" → `{ kind: "vm", id: "vm:103:nginx-prod", confidence: 0.85 }`
- "port 443" → `{ kind: "port", id: 443, protocol: "tcp" }`

When the user says "destroy it" in a follow-up, the session state already has the entity — no re-query, no re-disambiguation. This also enables cross-turn pronoun resolution ("it", "that one", "the one we just created").

### Concept: Dynamic Action Registry Documentation

Replace the hardcoded `ActionTool.ts` docstring with auto-generation:

```typescript
function generateActionDocs(registry: ActionRegistry): string {
  return registry.list().map(action => {
    const schemaShape = zodToJsonSchema(action.schema);
    return `${action.name}: ${action.description}\n  params: ${JSON.stringify(schemaShape.properties, null, 2)}`;
  }).join("\n\n");
}
```

This means the LLM always has up-to-date documentation of available actions. New actions appear automatically when registered.

### Concept: Unified Response Schema (`AgentResponseV1`)

A single typed envelope emitted by every runtime path — domain chain, LLM response, and error — consumed directly by the UI without text inference:

```typescript
interface AgentResponseV1 {
  version: "1";
  conversation: {
    state: "IDLE" | "NEED_CLARIFICATION" | "AWAITING_CONFIRMATION" | "READY_READ" | "READY_WRITE";
    pendingActionId?: string;
  };
  answer: {
    style: "TERSE_DATA" | "ASSISTIVE" | "EXPLAINER";
    summary: string;           // one-sentence answer — always present
    sections: Array<{
      type: "facts" | "table" | "diff" | "risk" | "next_steps" | "clarification" | "confirmation";
      title?: string;
      data: unknown;           // typed per section.type
    }>;
  };
  evidence: {
    toolCalls: Array<{ tool: string; ok: boolean; durationMs?: number; ref?: string }>;
    traceId?: string;
  };
  rawTextFallback?: string;    // backward compat; omit once UI is fully migrated
}
```

Key properties of this design:
- `conversation.state` gives the UI a machine-readable phase — no more parsing "I need clarification" from prose
- `answer.sections` is a typed array; the dashboard renders each section by its `type` discriminant, not by text heuristics
- `evidence.toolCalls` gives the reasoning trace to the UI without requiring a separate SSE subscription
- `rawTextFallback` preserves backward compatibility during migration

Domain chains return `AgentResponseV1` objects. LLM responses are requested with `zodResponseFormat(AgentResponseV1Schema, "response")`. The 480-line `formatAgentResponse` in `dashboard/js/chat.js` becomes a simple section renderer.

### Concept: Rolling Conversation Summary + Task-State Memory

Instead of injecting the last 50 raw messages into context (`server.ts:1671-1676`), introduce a rolling summary that compacts transcript into structured task state:

```typescript
interface ConversationSummary {
  goal: string;                       // what the user is trying to accomplish
  constraints: string[];              // stated limits ("don't touch production")
  unresolvedSlots: string[];          // outstanding clarifications needed
  lastActionResults: ActionSummary[]; // what was done and whether it succeeded
  resolvedEntities: Map<string, string>; // entity cache for the session
  ttl: number;                        // expiry for stale sessions
}
```

This compact artifact replaces bulk transcript replay with context that is:
- Token-efficient (the full transcript stays in the DB, not in the prompt)
- Semantically rich (goal + constraints are explicit, not inferred from prose)
- Resumable (cross-session entity cache means "remember last time" works)

A background summarization step after each assistant turn keeps the summary current without adding latency to the response path.

### Concept: Declarative Tool Selection

Replace the `tool_choice: "auto"` / `"required"` binary with a declarative policy:

```typescript
const toolPolicy = {
  QUERY: { required: ["twin_query"], allowed: ["proxmox_readonly"] },
  ACTION: { required: ["action"], allowed: ["proxmox_write", "opnsense_safewrite"] },
  DIAGNOSTIC: { required: ["infrastructure_diagnostic", "ssh_execute"], allowed: ["twin_query"] },
};
```

The runner looks up the policy based on classified intent and sets `tool_choice` accordingly. No more regex-driven `"required"` for real-time metric queries — it's just part of the DIAGNOSTIC policy.

---

## 13. Severity Matrix

| Issue | Area | Severity | Effort to Resolve | Impact |
|-------|------|----------|-------------------|--------|
| Linear pipeline — no typed state machine | Architecture | **Critical** | High | Chaining, multi-turn, composability |
| Output contract is path-dependent (formatter branches + dashboard heuristics) | Output | **High** | Medium | Response shape inconsistency, UI brittleness |
| Intent classifier uses Jaccard (no LLM) | Reasoning | **High** | Medium | Classification accuracy, generalization |
| Silent chain fallthrough (no LLM fallback signal) | Runner | **High** | Low | Response consistency, debugging |
| No structured output format for agent responses | Output | **High** | Medium | Dashboard rendering, reliability |
| `JSON.parse()` without validation in hot paths | Integrity | **High** | Low | Runtime errors, data loss |
| Conversation history is flat `{role, content}[]` | State | **High** | Medium | Multi-turn fidelity |
| Failure reclassification can loop beyond MAX_STEPS | Resilience | **Medium** | Low | Infinite-loop risk |
| Shell-string command assembly in terraform + ansible runners | Security/Reliability | **Medium** | Low | Quoting/escaping fragility under unexpected args |
| ActionTool docstring not auto-generated from registry | DX | **Medium** | Low | Action discovery reliability |
| Hardcoded node names in classifier and chains | Maintainability | **Medium** | Low | Breaks on infrastructure changes |
| Parallelization hardcoded to SSH+sensors | Performance | **Medium** | Medium | Latency for multi-node queries |
| `AgentContext.getMessages()` exposes mutable array | Code quality | **Medium** | Low | Subtle ordering bugs |
| Event bus `payload: Record<string, any>` (untyped) | Observability | **Medium** | Low | Fragile event consumers, silent contract drift |
| No frontend contract tests for `formatAgentResponse` | Testing | **Medium** | Low | Format regressions invisible to CI |
| Twin query incomplete path parsing TODO (`twin-query-service.ts:1783`) | Data integrity | **Medium** | Low | Reachability answers with empty path detail |
| Discovery framework uses simplified schema conversion | Schema | **Low** | Medium | Schema mismatch between tool definition and LLM input |
| Fusion weights hardcoded (no runtime tuning) | RAG | **Low** | Low | Retrieval quality optimization |
| Event bus `sessionId` optional (all-sessions broadcast) | Observability | **Low** | Low | Client-side filtering required |
| No dry-run optimization for `opnsense_safewrite` | UX | **Low** | Low | Unnecessary confirmation prompts |

---

## Appendix: File Reference Index

| File | LOC | Review Section |
|------|-----|---------------|
| `src/agent/runner.ts` | 3,550 | §4, §5, §6, §8 |
| `src/reasoning/intent-classifier.ts` | 611 | §5 |
| `src/pce/api/server.ts` | 2,385 | §3, §8 |
| `src/reasoning/chains/compute.ts` | ~570 | §5 |
| `src/reasoning/chains/firewall.ts` | ~563 | §5 |
| `src/reasoning/chains/network.ts` | ~365 | §5 |
| `src/reasoning/chains/exposure.ts` | ~232 | §5 |
| `src/reasoning/detectFirewallIntent.ts` | ~214 | §5 |
| `src/reasoning/detectNetworkIntent.ts` | ~127 | §5 |
| `src/reasoning/compute-intents.ts` | ~239 | §5 |
| `src/actions/compute/create-vm.ts` | ~600 | §7 |
| `src/actions/helpers/terraform-runner.ts` | ~730 | §7 |
| `src/actions/helpers/ansible-runner.ts` | ~200 | §7 |
| `src/agent/canonical-response-format.ts` | 109 | §6 |
| `src/agent/response-formatter.ts` | — | §6 |
| `src/agent/event-bus.ts` | 114 | §4, §9 |
| `src/agent/context.ts` | ~35 | §8 |
| `src/pce/rag/fusion.ts` | ~200 | §2 |
| `src/pce/rag/hybrid-orchestrator.ts` | ~300 | §2 |
| `src/tools/ActionTool.ts` | ~325 | §7 |
| `src/tools/TwinQueryTool.ts` | ~300 | §2, §7 |
| `src/tools/api-discovery/discovery-framework.ts` | — | §6 |
| `src/twin/api/twin-query-service.ts` | — | §6, §9 |
| `src/pce/api/profile-store.ts` | ~130 | §2 |
| `dashboard/js/chat.js` | — | §6, §9 |

---

## 14. Implementation Status — realAgent branch, March 2026

*Snapshot: commit `79c1303` (initial); updated 2026-03-05 to reflect P0+P1.2+P1.4 changes.*

---

### §14.1 — What Changed vs. Previous Review

| Issue (from §13) | Status | Notes |
|---|---|---|
| 3,550-line monolith `runner.ts` | **PARTIAL** | Handlers extracted to `src/agent/handlers/`; runner is ~3,296 lines (−254). Execute path still inline. |
| Double LLM call (`formatResponseForBot`) | **DONE** | Removed from main LLM loop path. `buildSystemPrompt(responseMode)` injects mode instructions into system prompt. `formatResponseForBot` still used by twin-first chains + RAG path (single-call paths, not double). |
| Jaccard/regex intent classifier | **DONE** | `classifyAndRouteWithLLM` is now always the primary path. `ENABLE_LLM_INTENT_CLASSIFIER` gate removed from code. Sync Jaccard path remains as the catch-block fallback on API failure. |
| Client-side conversation history | **TODO** | Flat array still passed per-request. `AgentStateV1` type defined but not instantiated. |
| Streaming / blank wait UX | **TODO** | `AgentEventBus` still used; no additional SSE wiring added. |
| Action layer / IaC prison | **TODO** | `ActionTool` docstring still hardcoded. No auto-generation from registry. |
| `event-bus` payload untyped | **DONE (execute path)** | Inline `emitFinalEvent`/`emitStepEvent` closures in `runner.ts` deleted. All 17 `emitFinalEvent` + 6 `emitStepEvent` call sites now use typed versions from `emit-helpers.ts`. `event-bus.ts` `AgentEvent.data` interface still `Record<string,any>` — that's a 1-line change remaining. |
| `JSON.parse` without validation | **TODO** | Still endemic in runner hot path and tool argument parsing. |

---

### §14.2 — New Work Added

#### 1. Handler Modules (`src/agent/handlers/`)

The largest structural change: five concerns extracted from `runner.ts` into typed handler functions. The runner calls these at the top of `runAgent()` before the execute path.

| File | Responsibility |
|---|---|
| `handle-confirmation.ts` | 5 confirmation paths: cancel, no-pending, wrong-id, expired, pass-through with `effectiveInput` |
| `handle-identity.ts` | Name update, name query, assistant name, CHAT_SOCIAL, subnet sizing |
| `handle-confirm-request.ts` | ASK_CONFIRM: builds pending action record, emits confirmation prompt |
| `handle-clarify.ts` | ASK_CLARIFY when domain detectors don't bypass: disambiguation, ask_missing, generic |
| `emit-helpers.ts` | Typed `emitStepEvent` / `emitFinalEvent` using `AgentFinalPayload` / `AgentStepPayload` schemas |
| `identity-helpers.ts` | Pure helpers: `extractUserNameUpdate`, `isUserNameQuery`, `isAssistantNameQuery` |

**Impact:** Early-return paths are testable in isolation. Typed I/O interfaces on each handler. Observability: traces record `handler + decision` for every router path.

**Remaining gap:** `runner.ts` execute path (RAG, LLM loop, tool execution, reclassification) is still inline — no `handle-execute.ts` yet; that path is ~2,200 lines.

#### 2. `AgentStateV1` — Typed State Interface (`src/agent/state.ts`)

Defines a typed `AgentStateV1` interface carrying: `classification`, `routing`, `conversationPlan`, `confirmation`, `clarificationContinuation`, `tools`, `contextUpdate`, `ragPayload`.

**Good:** The interface exists and mirrors what `runner.ts` locals already track.

**Gap:** `AgentStateV1` is never instantiated in `runner.ts`. All those fields remain as separate local variables. The type exists as documentation, not enforcement.

#### 3. Typed Event Payloads (`src/agent/event-payloads.ts`)

Zod schemas for all `AgentEvent` payload types: `ToolStartPayload`, `ToolCompletePayload`, `ToolProgressPayload`, `LlmTokenPayload`, `AgentStepPayload`, `AgentFinalPayload` — and a discriminated union `AgentEventData`.

**Good:** `emit-helpers.ts` uses these schemas. Schemas are precise and complete.

**Fixed (2026-03-05):** Inline closures in `runner.ts` deleted. All emit call sites now use the typed versions from `emit-helpers.ts`. `event-bus.ts` `AgentEvent.data` interface still `Record<string,any>` — one-line change remaining (P2.1).

#### 4. `AgentResponseV1Schema` (`src/agent/schemas/agent-response-v1.ts`)

The unified response envelope from §12 is fully defined as a Zod schema: `conversation.state`, `answer.style + summary + sections[]`, `evidence.toolCalls[]`, `rawTextFallback`.

**Good:** Schema exactly matches the v2 architecture proposal. `rawTextFallback` provides correct backward-compatibility path.

**Critical gap:** `AgentResponseV1Schema` is never passed to `generateObject()` in runner or `response-formatter`. The dashboard's 480-line `formatAgentResponse` heuristic is still the rendering path.

#### 5. LLM Intent Classifier (`classifyIntentWithLLM`)

`IntentClassificationSchema` (Zod) defines the structured output contract. `classifyIntentWithLLM` calls `generateObject()` via the Vercel AI SDK. `mapLLMResultToIntentClassification` bridges back to the existing `IntentClassification` type. Falls back to sync `classifyIntent` on API/parse failure.

**Good:** Uses `generateObject()`. Schema is well-designed: flat, clear descriptions, `missingSlots`, `composite` flag.

**Fixed (2026-03-05):** Feature flag removed. `classifyAndRouteWithLLM` is now always the primary path. The 5-domain regex detector waterfall still runs before classification on every request — reducing these to post-classification validators is P3.2.

#### 6. Composite Query Detection (`src/reasoning/composite-query.ts`)

`isLikelyCompositeQuery()` identifies multi-dimensional queries (e.g. “VMs on yang and their exposure level”). Routes to EXECUTE path so the LLM can coordinate multiple tools instead of a single chain.

**Good:** Correctly bypasses `tool_first_domain` skip for composite queries.

**Note:** Pattern list is narrow (exposure + subnet/node combinations). Multi-step action composition (create VM + bootstrap + DNS) not yet detected as composite.

#### 7. Retrieval Eligibility Module (`src/agent/retrieval-eligibility.ts`)

`getRetrievalEligibility()` extracted from runner. Accepts `isCompositeQuery` parameter; correctly allows RAG for composite queries in tool-first domains. `TOOL_FIRST_DOMAINS` exported as shared constant.

#### 8. Runner Structural Improvements

- `classifyAndRoute` and `classifyAndRouteWithLLM` both imported; env var selects path at runtime
- `isLikelyCompositeQuery` called at classification time, passed to `getRetrievalEligibility`
- `recordRouterTrace()` closure records handler + decision for every early-return path
- `normalizeUserName()` extracted (was inline string ops)
- `runner.ts.bak` committed alongside `runner.ts` for diff visibility

---

### §14.3 — Remaining Issues (Priority Order)

#### P0 — Build / Correctness

**P0.1 ✅ DONE (2026-03-05):** Inline `emitFinalEvent` and `emitStepEvent` closures in `runner.ts` deleted. All 23 call sites updated to use typed versions from `emit-helpers.ts`. `agent:final` payload now enforces `AgentFinalPayload` schema end-to-end.

---

#### P1 — High Impact, Low Effort

**P1.1: Wire `AgentStateV1` into `runner.ts`**

Assemble the 35+ local variables into a typed `AgentStateV1` object immediately after classification. Pass state to handlers and the execute path instead of individual parameters.

**P1.2 ✅ DONE (2026-03-05):** `ENABLE_LLM_INTENT_CLASSIFIER` gate removed. `classifyAndRouteWithLLM` is now always the primary path; sync Jaccard remains as the catch-block fallback. Unused import and helper function cleaned up.

**P1.3: Wire `AgentResponseV1Schema` to `generateObject()` in the execute path**

The schema exists. The Vercel AI SDK (`ai@5`) is already used in `intent-router.ts`. Connecting them eliminates free-form text output and removes the need for the 480-line dashboard heuristic parser. `rawTextFallback` preserves backward compat during migration.

**P1.4 ✅ DONE (2026-03-05):** `formatResponseForBot` removed from the main LLM loop path. `buildSystemPrompt(responseMode?)` added to `system-prompt.ts` — appends TERSE_DATA/ASSISTIVE/EXPLAINER instructions to the system prompt so the LLM formats on the first call. `buildBotMoveContext` enrichment preserved. `formatResponseForBot` still used by twin-first chains + RAG path (those are single-call paths, not double).

---

#### P2 — Medium Effort, High Value

**P2.1: Fully type the event bus**

`event-bus.ts` `AgentEvent.data` is still `Record<string, any>`. With `AgentEventData` already defined in `event-payloads.ts`, this is a one-line interface change. All emit sites become type-checked.

**P2.2: Fix `JSON.parse` without validation in the tool dispatch hot path**

```typescript
// Current
parsedArgs = fnCall.arguments ? JSON.parse(fnCall.arguments) : {};
// Fix
try {
  parsedArgs = fnCall.arguments ? JSON.parse(fnCall.arguments) : {};
  if (tool.inputSchema) tool.inputSchema.parse(parsedArgs);
} catch (err) {
  return { error: 'Invalid tool arguments', raw: fnCall.arguments };
}
```

**P2.3: Extract execute path into `handle-execute.ts`**

The execute path (RAG → system prompt → LLM loop → tool dispatch → reclassification) is ~2,200 lines inline. Extracting to `handle-execute.ts` completes the handler decomposition; runner becomes ~200 lines. Requires P1.1 (AgentStateV1 wired) first.

**P2.4: Formalize and test the server-owned conversation history contract**

`ChatHistoryStore` is already wired in `src/pce/api/server.ts`: the server creates conversations, loads history/context, passes `conversationHistory`/`conversationState`/`conversationContext` into `runAgent`, and persists assistant output plus conversation updates from `agent:final`. The remaining gap is to document and test that ownership boundary explicitly so `runAgent` remains storage-agnostic.

---

#### P3 — Architectural (Longer Term)

**P3.1:** Persist session-scoped entity resolution cache in `AgentStateV1` (resolves “yang” → “YANG”, “the web server” → “vm:103” across turns)

**P3.2:** Auto-generate `ActionTool` documentation from registry Zod schemas via `zod-to-json-schema` — LLM always sees up-to-date action docs

**P3.3:** Plan-before-execute node for multi-step action composition (create VM + bootstrap + DNS) with explicit `ActionStep[]` dependency ordering and rollback tracking

---

### §14.4 — Updated Severity Matrix

| Issue | Severity | Effort | Status / Path |
|---|---|---|---|
| `runner.ts` inline `emitFinalEvent` shadows typed version | ~~P0~~ | — | ✅ **Fixed 2026-03-05** |
| Double LLM call (`formatResponseForBot`) on main path | ~~High~~ | — | ✅ **Fixed 2026-03-05** — `buildSystemPrompt(mode)` |
| `AgentStateV1` defined but never used | **High** | Medium | Instantiate post-classification; thread through handlers |
| LLM classifier feature-flagged off | ~~High~~ | — | ✅ **Fixed 2026-03-05** — gate removed |
| `AgentResponseV1Schema` not wired to `generateObject` | **High** | Medium | Use `generateObject(schema)` in execute path |
| `event-bus.data` still `Record<string,any>` | **Medium** | 1 line | Swap to `AgentEventData` union type |
| `JSON.parse` without validation in hot path | **Medium** | Low | Add try/catch + `schema.parse` at tool dispatch |
| Execute path still ~2,200 lines inline | **Medium** | High | Extract `handle-execute.ts` (needs P1.1 first) |
| Server-owned conversation history contract not tested/documented | **Medium** | Medium | Keep persistence in `PceApiServer`; add injected-runner tests + update review text |
| `ActionTool` docstring manually maintained | **Medium** | Low | Auto-generate from Zod schemas via `zod-to-json-schema` |
| `canonical-response-format.ts` still present | **Low** | Low | Remove once `AgentResponseV1Schema` is primary path |
| Domain regex waterfall still runs pre-classification | **Low** | Medium | Reduce to post-classification validators after P1.2 |

---

### §14.5 — What Is Working Well

These are solid and should not be changed:

- **Clean build:** `tsc --noEmit` passes with zero errors
- **Handler extraction quality:** typed I/O interfaces, proper separation of concerns, observability traces aligned with handler paths
- **`emit-helpers.ts` + `event-payloads.ts`:** the typed event payload system is well-designed and complete; just needs to replace the runner's inline closure
- **`AgentResponseV1Schema`:** exactly the right shape — just needs to be wired to `generateObject()`
- **`IntentClassificationSchema` + `mapLLMResultToIntentClassification`:** excellent Zod schema, correct mapping, clean fallback to sync classifier
- **`isLikelyCompositeQuery`:** correct detection, correctly integrated with retrieval eligibility
- **`AgentStateV1` interface:** right shape — just needs to be instantiated
- **`runner.ts.bak`:** keeping the diff visible in-repo is a useful practice during refactors
- **`REVIEW.md` as source of truth:** clear signal of intent, well-structured

---

*Original review generated 2026-03-03 against ~180 source files. §14 updated 2026-03-05 from realAgent branch snapshot (commit `79c1303`).*
