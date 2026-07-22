# Plan: Palindrome Architectural Improvements
**Date:** 2026-03-03
**Phases:** 3 (independent → independent → depends on both)

---

## Context

Three architectural improvements identified in REVIEW.md:
1. **Atomic Tooling** — `ActionTool` dispatches 10 actions via `params: z.any()`. The LLM sees zero parameter guidance for the most consequential operations. Each action already has a strict Zod schema. The gap is purely at the tool-interface layer.
2. **Structured Outputs** — LLM responses are free-form text. `generateObject()` from the already-installed `ai@5.0.93` replaces the formatter LLM call, the Jaccard intent classifier, and the entity extractor. Zero new major deps (one adapter install).
3. **State Machine** — `runner.ts` is 3,550 lines implementing a state machine as procedural if/else. `ConversationState`, `ConversationContext`, and `DialogPolicy` already exist. The refactor extracts the 12+ early-return paths into typed handlers. `runner.ts` becomes ~200-300 LOC.

**Constraint:** DO NOT use LangGraph. Custom TypeScript state machine using existing types.
**Invariant:** Each phase ships independently and passes `bun test` on completion.
**Order:** Phase 1 and Phase 2 are independent. Phase 3 requires both.

---

## Phase 1 — Atomic Tooling

### Goal
Replace `ActionTool`'s `{ action: string, params: z.any() }` with 10 individual typed `BaseTool` subclasses — one per action. The LLM sees strict per-action schemas. Per-action ACL/risk replaces the single shared `"medium"` risk level.

### New Files (11)
`src/tools/actions/` directory:
- `CreateVmTool.ts` — wraps `CreateVmSchema` from `src/actions/compute/create-vm.ts`
- `DestroyVmTool.ts` — wraps `DestroyVmSchema`
- `CreateDnsRecordTool.ts` — wraps `CreateDnsRecordSchema`
- `SyncDhcpToDnsTool.ts` — wraps `SyncDhcpToDnsSchema`
- `SetInterfaceVlanTool.ts` — wraps `SetInterfaceVlanSchema`
- `BootstrapTool.ts` — wraps `BootstrapSchema`
- `InstallDockerTool.ts` — wraps `InstallDockerSchema`
- `InstallNginxTool.ts` — wraps `InstallNginxSchema`
- `ConfigureFirewallTool.ts` — wraps `ConfigureFirewallSchema`
- `SetStaticIpTool.ts` — wraps `SetStaticIpSchema`
- `index.ts` — barrel export

### Pattern to Follow
`TwinQueryTool.ts` and `ProxmoxReadOnlyTool.ts` are the precedents.
Each tool class:
1. Extends `BaseTool` with explicit `name`, `description`, per-action `risk`, `allowedAcls`, `requiresConfirmation`
2. Implements `getSchema()` using `createToolSchema(this, ActionSchema, { examples, notes })` from `src/tools/tool-helpers.ts`
3. Implements `getParameterSchema()` returning the action's Zod schema
4. In `execute()`: `Schema.safeParse(params)` → call `actionRegistry.get("domain.name").execute(parsed.data)` → emit progress events via `AgentEventBus`

### Per-Action ACL/Risk Map
| Tool | `risk` | `allowedAcls` | `requiresConfirmation` |
|---|---|---|---|
| `CreateVmTool` | `"high"` | `["admin"]` | `false` |
| `DestroyVmTool` | `"high"` | `["admin"]` | `false` |
| `CreateDnsRecordTool` | `"medium"` | `["admin","ops"]` | `false` |
| `SyncDhcpToDnsTool` | `"medium"` | `["admin","ops"]` | `false` |
| `SetInterfaceVlanTool` | `"high"` | `["admin"]` | `false` |
| `BootstrapTool` | `"medium"` | `["admin","ops"]` | `false` |
| `InstallDockerTool` | `"medium"` | `["admin","ops"]` | `false` |
| `InstallNginxTool` | `"medium"` | `["admin","ops"]` | `false` |
| `ConfigureFirewallTool` | `"high"` | `["admin"]` | `false` |
| `SetStaticIpTool` | `"high"` | `["admin"]` | `false` |

### Modified Files (2)
**`src/agent/tool-loader.ts`** — import and add all 10 new tools to the returned array. Keep `ActionTool` for now.

**`src/tools/ActionTool.ts`** — append to the description: `"DEPRECATED: Use specific action tools (action_create_vm, action_destroy_vm, …) instead."` No logic changes.

**`src/agent/runner.ts`** — `summarizeToolCall()` (~line 1071) and `inferMissingToolSlots()` (~line 1113) have `toolName === "action"` checks. Add parallel branches for each new tool name (`"action_create_vm"`, `"action_destroy_vm"`, etc.).

### Deleted Files
None in Phase 1. `ActionTool.ts` is deleted in Phase 3 after handle-execute.ts no longer references `"action"`.

### Tests
- `bun test tests/actions/` — unchanged (action functions untouched)
- Add `tests/tools/actions/create-vm-tool.test.ts` — verify `getSchema()` output contains no `additionalProperties: true`

---

## Phase 2 — Structured Outputs (Vercel AI SDK `generateObject`)

### Goal
Replace free-form LLM outputs with `generateObject()` + Zod schemas. Four targets: response formatter, intent classifier, entity extractor, event bus payloads. Define `AgentResponseV1` schema for use in Phase 3.

### Prerequisite
```bash
bun add @ai-sdk/openai
```
The `ai@5.0.93` package is installed but the OpenAI adapter is not. This is the only new dependency.

### New Files (3)

**`src/reasoning/intent-schema.ts`**
```typescript
import { DOMAINS } from "./domain-taxonomy";

export const IntentClassificationSchema = z.object({
  intent: z.enum(["QUERY", "ACTION", "CHAT_SOCIAL", "CHAT_REASONING", "CLARIFICATION"]),
  confidence: z.number().min(0).max(1),
  domain: z.enum(DOMAINS).optional(),
  actionType: z.enum(["create","destroy","start","stop","restart","install","configure"]).optional(),
  risk: z.enum(["READ", "WRITE_LOW", "WRITE_HIGH", "DESTRUCTIVE"]),
  missingSlots: z.array(z.string()),
  entities: z.object({
    hosts: z.array(z.string()),
    services: z.array(z.string()),
    resourceIds: z.array(z.string()),
  }),
});
```
Implemented with `domain-taxonomy.ts` as the canonical domain source; never copy a
domain enum into this historical implementation journal.
Must be compatible with the existing `IntentClassification` interface that `evaluateDialogPolicy()` consumes.

**`src/agent/schemas/agent-response-v1.ts`**
Defines `AgentResponseV1Schema` (the typed response envelope for Phase 3):
```typescript
export const AgentResponseV1Schema = z.object({
  version: z.literal("1"),
  conversation: z.object({
    state: z.enum(["IDLE","NEED_CLARIFICATION","AWAITING_CONFIRMATION","READY_READ","READY_WRITE"]),
    pendingActionId: z.string().optional(),
  }),
  answer: z.object({
    style: z.enum(["TERSE_DATA","ASSISTIVE","EXPLAINER"]),
    summary: z.string(),
    sections: z.array(z.object({
      type: z.enum(["facts","table","diff","risk","next_steps","clarification","confirmation"]),
      title: z.string().optional(),
      data: z.unknown(),
    })),
  }),
  evidence: z.object({
    toolCalls: z.array(z.object({ tool: z.string(), ok: z.boolean(), durationMs: z.number().optional() })),
    traceId: z.string().optional(),
  }),
  rawTextFallback: z.string().optional(),
});
```

**`src/agent/event-payloads.ts`**
Typed Zod schemas for every `AgentEvent.data` payload shape (AgentFinalPayload, ToolProgressPayload, AgentStepPayload). Discriminated union exported as `AgentEventData`.

### Modified Files (5)

**`src/agent/event-bus.ts`** — update `AgentEvent.data` type to use `AgentEventData` discriminated union from `event-payloads.ts`. The `emit()` call sites are backward-compatible (they pass plain objects; TypeScript will catch mismatches).

**`src/agent/response-formatter.ts`** — Replace the `client.chat.completions.create()` call inside `formatResponseForBot()` (~line 769) with:
```typescript
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
const { object } = await generateObject({
  model: createOpenAI({ apiKey: process.env.OPENAI_API_KEY })("gpt-4o-mini"),
  schema: z.object({ formatted: z.string(), skipped: z.boolean() }),
  system: systemPrompt,
  prompt: userPrompt,
  temperature: 0.1,
  maxTokens: 4000,
});
return object.skipped ? rawResponse : object.formatted;
```

**`src/reasoning/intent-router.ts`** — Add `classifyAndRouteWithLLM(userInput: string): Promise<{ classification, routing }>` using `generateObject(IntentClassificationSchema)`. Maps result to existing `IntentClassification` + `RoutingDecision` interfaces. The existing synchronous `classifyAndRoute()` is kept as fallback.

**`src/agent/runner.ts`** — Change the single call at line 1240:
```typescript
// Before
const { classification, routing } = classifyAndRoute(userInput);
// After
const { classification, routing } = await classifyAndRouteWithLLM(userInput);
```

**`src/pce/edl/extraction/extractor.ts`** — Replace `response_format: { type: "json_object" }` (~line 72) with `generateObject(ExtractionResultSchema)`. Schema guarantees `entities[]` and `relationships[]` with typed enum values.

### Deleted Files
None.

### Tests
- `bun test tests/reasoning/` — existing synchronous classifier tests still pass
- Add `tests/reasoning/intent-llm.test.ts` — mock `generateObject` via `vi.mock('ai')`, verify schema mapping
- Add `tests/agent/response-formatter.test.ts` — mock `generateObject`, verify skip conditions preserved

---

## Phase 3 — State Machine

### Goal
Extract `runner.ts` (3,550 LOC) into 5 typed handler files. `runner.ts` becomes a thin router (~250 LOC). Uses `AgentStateV1` typed state object. `ConversationState`, `ConversationContext`, `DialogPolicy` are **unchanged**.

### New Files (9)

**`src/agent/state.ts`** — `AgentStateV1` interface + `buildAgentState()` factory:
```typescript
export interface AgentStateV1 {
  originalUserInput: string;
  effectiveUserInput: string;
  sessionId: string;
  startTime: number;
  session: ToolSession;
  options: AgentRunOptions;
  classification: IntentClassification;      // from Phase 2 schema
  routing: RoutingDecision;
  conversationPlan: OrchestratorDecision;    // from dialog-policy.ts
  confirmation: ConfirmationParseResult;
  clarificationContinuation: ClarificationContinuationResult;
  tools: BaseTool[];
  contextUpdate: Partial<ConversationContext>;
  finalContextUpdate: Partial<ConversationContext>;
  postExecutionState: ConversationState;
  responseMode: ResponseMode | undefined;
  ragPayload: HybridApiContext | null;
}
```

**`src/agent/handlers/handle-confirmation.ts`** — extracts runner.ts lines 798-912 (5 confirmation early-return paths). Returns `{ handled: true, response }` or `{ handled: false, effectiveInput }`.

**`src/agent/handlers/handle-identity.ts`** — extracts runner.ts lines 1297-1459 (name updates, name queries, CHAT_SOCIAL). Returns `{ handled: true, response }` or `{ handled: false }`.

**`src/agent/handlers/handle-confirm-request.ts`** — extracts runner.ts lines 1495-1537 (ASK_CONFIRM path: build pendingRecord, format prompt, emit).

**`src/agent/handlers/handle-clarify.ts`** — extracts runner.ts lines 1539-1903 (ASK_CLARIFY path: domain bypass check, disambiguation, slot collection, clarification message).

**`src/agent/handlers/handle-execute.ts`** — extracts runner.ts lines 1905-3515 (EXECUTE + RESPOND_ONLY: twin-first chains, RAG injection, main LLM loop, MAX_STEPS, tool dedup, reclassification). `summarizeToolCall()` and `inferMissingToolSlots()` move here. This handler is the only substantial implementation file.

**`src/agent/handlers/emit-helpers.ts`** — extracts `emitFinalEvent()`, `emitStepEvent()` from runner.ts. Used by all handlers. Uses `AgentFinalPayload` from Phase 2.

**`src/agent/handlers/index.ts`** — barrel.

### Modified Files (1)

**`src/agent/runner.ts`** — body of `runAgent()` becomes:
```typescript
// 1. Normalize options → sessionId, startTime, session, tools
// 2. parseConfirmationInput, resolveClarificationContinuationInput
// 3. await classifyAndRouteWithLLM(userInput)         [Phase 2]
// 4. planConversation(...)                             [existing]
// 5. buildAgentState(...)

const confirmResult = await handleConfirmation(state);
if (confirmResult.handled) return confirmResult.response;
state.effectiveUserInput = confirmResult.effectiveInput;

const identityResult = await handleIdentityAndSocial(state);
if (identityResult.handled) return identityResult.response;

switch (conversationPlan.decision) {
  case "ASK_CONFIRM":  return handleConfirmRequest(state);
  case "ASK_CLARIFY":  return handleClarify(state, context);
  default:             return handleExecute(state, context, eventBus);
}
```

Top-level constants (`MODEL_ID`, `ASSISTANT_NAME`, `getOpenAIClient()`, `buildToolDefinitions()`) remain in `runner.ts` as they are imported by other modules.

### Deleted Files (1)
**`src/tools/ActionTool.ts`** — safe to delete once `handle-execute.ts` references `action_create_vm` etc. instead of `"action"`.

### Tests
- `bun test tests/runner*.test.ts` — public `runAgent()` signature unchanged; tests pass
- Add `tests/agent/handlers/handle-confirmation.test.ts` — unit test each of the 5 confirmation paths with mocked `AgentStateV1`

---

## Dependency Graph

```
Phase 1 (Atomic Tooling)     Phase 2 (Structured Outputs)
        │                              │
        └──────────────┬──────────────┘
                       ▼
               Phase 3 (State Machine)
```

Phase 1 and 2 are independent — can ship in any order or in parallel.
Phase 3 requires Phase 1 (typed tool names in handle-execute, ActionTool deletion) and Phase 2 (IntentClassification schema in AgentStateV1, AgentFinalPayload in emit-helpers).

---

## Critical Files

| File | Phase | Role |
|---|---|---|
| `src/tools/ActionTool.ts` | P1 | Soft-deprecated → deleted in P3 |
| `src/actions/registry.ts` | P1 | Source of all 10 Zod schemas — import, don't duplicate |
| `src/tools/tool-helpers.ts` | P1 | `createToolSchema()` — use this pattern |
| `src/tools/tool-schema.ts` | P1 | `zodToJsonSchema()` — already handles all action schema types |
| `src/agent/tool-loader.ts` | P1 | Add 10 new tools |
| `src/agent/response-formatter.ts` | P2 | Replace LLM call with `generateObject` |
| `src/reasoning/intent-router.ts` | P2 | Add async LLM classifier wrapper |
| `src/pce/edl/extraction/extractor.ts` | P2 | Replace `json_object` mode |
| `src/agent/event-bus.ts` | P2 | Type event payloads |
| `src/agent/runner.ts` | P3 | Becomes thin router; all handler logic extracted |
| `src/agent/dialog-policy.ts` | P3 | Unchanged — router delegates to it |
| `src/types/conversation.ts` | P3 | `ConversationState` — unchanged |

---

## Verification

```bash
# After Phase 1
bun test tests/actions/
bun test tests/tools/

# After Phase 2
bun test tests/reasoning/
bun test tests/agent/response-formatter.test.ts

# After Phase 3
bun test                        # full suite
bun run agent "list vms on yang"  # smoke test end-to-end
bun run agent "create a vm"       # confirm action routes to CreateVmTool
```
