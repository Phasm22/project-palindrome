# Principled Dev Agent Memory

## Project: palindrome

### Runtime & Commands
- Runtime: **Bun** (not Node/npm). Always use `bun` / `bunx`.
- Tests: `bun test` (Vitest under Bun). Single file: `bun test tests/path/to/file.ts`.
- Type check: `bunx tsc --noEmit`

### Key Architecture
- Agent entry: `src/agent/runner.ts` — thin coordinator ~1950 lines (after P2.3 extraction)
- Execute path: `src/agent/handlers/handle-execute.ts` — RAG → LLM loop → tool dispatch (~1390 lines)
  - `HandleExecuteInput` interface holds all state from outer scope needed by the execute path
  - Module-level helpers exported from runner.ts for re-use: `buildToolDefinitions`, `buildProvenance`, `buildRetrievalArtifacts`, `buildRetrievalToolCalls`, `coerceTextContent`, `hasDomainMatch`, `buildConversationMemoryPrompt`, `RETRIEVAL_MIN_SCORE`, `COMPOSITE_MULTI_STEP_INSTRUCTION`, `getOpenAIClient`, `formatRagSummary`
  - `buildBotMoveContext` closure moved verbatim inside `handleExecute` (uses tools + session)
- Handlers live in `src/agent/handlers/` — each exported through `src/agent/handlers/index.ts`
- Typed event helpers: `src/agent/handlers/emit-helpers.ts`
  - `emitFinalEvent(eventBus, sessionId, startTime, text, extra?)` — never use inline closure version
  - `emitStepEvent(eventBus, sessionId, data)` — never use inline closure version
- Event payloads typed in `src/agent/event-payloads.ts` (Zod schemas with `.passthrough()`)

### Established Patterns
- All `emitFinalEvent` / `emitStepEvent` calls must use the typed versions from `./handlers`, not inline closures
- Direct `eventBus.emit({...})` calls inside the LLM for-loop in `handle-execute.ts` are intentional — do not convert them
- `AgentFinalPayloadSchema` uses `.passthrough()` so extra fields (conversationContext, etc.) survive serialization
- `confirmationAbort` / `clarificationAbort` typed as `{ prompt: string; context: ConversationContext; state: ConversationContext }` with `as any` for the state field (originally `ConversationState` string literal but stored as ConversationContext shape)

### Action Layer
- Action schemas live in `src/actions/{compute,network,services}/` — each exports a `*Schema` (Zod) and function
- `src/actions/registry.ts` — singleton `actionRegistry`; `ActionDefinition.schema` is the Zod schema
- `src/actions/action-docs-generator.ts` — `generateActionParamsDoc(actions)` generates runtime doc string from registry schemas
- `src/tools/ActionTool.ts` — `buildDynamicSchema()` private method uses `generateActionParamsDoc()`; `ActionParams` (static const) is kept for `execute()` validation only
- `src/tools/actions/` — 10 atomic tool wrappers (CreateVmTool, etc.) used by tests; these are separate from the monolithic ActionTool

### Tool Schema Notes
- `zodToJsonSchema()` in `tool-schema.ts`: for `ZodDefault`-wrapped fields, the wrapper's `.describe()` is NOT propagated to the JSON schema property — only the inner type's description flows through (except for enum defaults). Design constraint to be aware of when writing schema descriptions.

### Testing Notes
- `tests/agent/` covers runner, response-formatter, retrieval-eligibility, synthesis-prompt, intent-llm
- The confirmation-flow tests are sensitive to LLM mock ordering; run in isolation if they flake in the full suite
- 86 tests across 19 files in `tests/reasoning/ tests/agent/` as of 2026-03-07 (P2.3 complete)
