# Reasoning trace observability

## What gets recorded

Each agent run that reaches a **final response** records one reasoning trace (e.g. `3f525eda-af3d-457d-8d02-8776421afff5`). The trace is stored in `.pce-dashboard/reasoning-traces.db` and includes:

- **userInput** — Effective input for this run (after clarification continuation or confirmation replay, if any).
- **finalResponse** — The text returned to the user.
- **steps** — Array of reasoning steps. Each step has:
  - **toolCalls** — Tools invoked (e.g. `ask_missing`, `action`, `twin_query`).
  - **decisions** — Why the agent did what it did.

## Conversation path (EXECUTE runs)

For runs that reach the **EXECUTE** path (main LLM loop), the **first step** now includes a `conversation_path` decision so the trace tells the same story as the PCE logs:

- **decision**: `"EXECUTE"`.
- **metadata**:
  - **conversationStateBefore** — State when this run started (e.g. `AWAITING_CONFIRMATION`).
  - **usedClarificationContinuation** — `true` if this run used a prior clarification reply (e.g. user said "YANG" after "create a vm pleas").
  - **clarificationAnchor** — The original user message that triggered the clarification (e.g. `"create a vm pleas"`).
  - **usedPendingAction** — `true` if the user had just confirmed a pending action (e.g. `CONFIRM 3dde7afa`).
  - **pendingActionId** — Confirmation id when applicable.
  - **originalUserInput** — Raw input for this run (e.g. `"CONFIRM 3dde7afa"`).
  - **effectiveUserInput** — Input used for execution (e.g. `"create a vm pleas on YANG"`).

So a trace for a flow like *create VM → clarify node → confirm → execute* will show in step 0: path `user_confirmed → clarification_continuation → EXECUTE` and the metadata above, plus the tool calls (e.g. `action` with `compute.create_vm`) and their results.

## Handler wiring (Phase 3)

The agent uses dedicated handlers before the main loop:

- **handleConfirmation** — Cancelled / confirm mismatch / expired / replay pending input.
- **handleIdentityAndSocial** — Name update, name query, assistant name, CHAT_SOCIAL, subnet sizing.
- **handleConfirmRequest** — When `conversationPlan.decision === "ASK_CONFIRM"` (build pending action, emit prompt).
- **handleClarifyFromPlan** — When `conversationPlan.decision === "ASK_CLARIFY"` and no domain bypass (ask_missing, disambiguation).

Only runs that pass these and reach **EXECUTE** record the trace with the main loop steps; clarify/confirm returns do not write a trace today (they could be added later if needed).

## Example: “create a vm pleas” → YANG → CONFIRM

1. **Run 1** — Input: `"create a vm pleas"`. Decision: **ASK_CLARIFY** (missing node). Tool: `ask_missing`. No trace (early return).
2. **Run 2** — Input: `"YANG"`. Continuation merges to effective: `"create a vm pleas on YANG"`. Decision: **ASK_CONFIRM**. Pending id `3dde7afa`. No trace (early return).
3. **Run 3** — Input: `"CONFIRM 3dde7afa"`. Confirmation handled; effective input replayed: `"create a vm pleas on YANG"`. Decision: **EXECUTE**. Tool: `action` (`compute.create_vm` for name `pleas`, node `YANG`). **Trace recorded** with:
   - `conversation_path`: `user_confirmed → clarification_continuation → EXECUTE`
   - `originalUserInput`: `"CONFIRM 3dde7afa"`, `effectiveUserInput`: `"create a vm pleas on YANG"`
   - Tool call `action` with params and result (success/failure).

If the action fails (e.g. Terraform error), the trace still contains the full path and the failing tool call result (error message in `toolCalls[].result.error`). The Terraform failure in the log (“template 8000 on node 'yin'”) was for a **different** VM (“apple” on yin) in the same Terraform plan; the user’s VM “pleas” on YANG was created successfully before that failure.
