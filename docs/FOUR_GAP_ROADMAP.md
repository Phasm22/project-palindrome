# Four-Gap Architecture Roadmap

**Status:** planning only — no production code changed to produce this. Decisions A–E resolved 2026-07-23.
**Branch:** `realAgent` @ `60626b6`. **Method:** six read-only sub-agents mapped to a four-gap taxonomy
(Representation · Capability · Execution · Expression), plus cross-cutting semantic-evaluation and
high-churn analysis. This document **reconciles** `REVIEW.md`, `docs/PARITY_AUDIT.md`, and
`docs/CODE_SMELLS.md` into the four gaps rather than replacing them.

Per-agent evidence (fresh `path:line` citations) and the flat task table were produced alongside this and
can be regenerated; this document is the self-contained organizing frame. Re-verify citations against
current source before implementing — a code snapshot decays.

**Review standard applied:** every added abstraction/route/adapter/formatter/retry/fallback is a cost.
Each epic states what it **deletes or consolidates**; net-new mechanism is justified only where no
existing implementation can be generalized. All five resolved decisions below are net-deletions.

---

## 1. The diagnosis: two themes, seven invariants

The gaps are instances of two recurring design pressures, not twenty unrelated bugs.

- **Theme A — Parity erosion:** a correct fix/feature lands in one representative path; structurally
  parallel siblings are never updated; nothing enforces agreement.
- **Theme B — Boundaries never isolated:** destructive/trust-crossing operations default to global scope
  on a shared substrate.

Each recurring sub-theme resolves to a stable architectural property whose absence caused the family. The
invariants are implementation-independent — they remain valid if the runtime, LLM, graph store, or tool
set is replaced wholesale. **For every invariant, the remedy already exists somewhere in this repo; the
work is to generalize it, not to add a framework.**

| # | Missing property | Invariant | Already-right example to generalize |
|---|------------------|-----------|-------------------------------------|
| **T1** | Canonical ownership of deterministic logic | Every deterministic operation has exactly one execution implementation; siblings invoke it, not re-embed it. | `bootstrap.ts:126-207` (correct retry) |
| **T2** | Completeness/parity enforcement | Every set of parallel implementations has a machine-checked completeness test that fails when a member omits the contract. | `CLASSIFICATION_STANDARDS.md` + `domain-taxonomy-completeness.test.ts` + `domain-consumers.ts` |
| **T3** | Single authoritative source per concept | Every domain concept and capability has exactly one authoritative source; all else is generated from it, never hand-edited. | `export-tool-schemas.ts` (derive-not-hand-maintain) |
| **T4** | Explicit ownership/scoping of mutable & trust boundaries | Every mutable resource has one owner; every destructive or trust-crossing op is scoped to a declared boundary, not global by default. | Qdrant `AUDIT_COLLECTION` isolation; the 11 existing `escapeHtml` calls; `sanitizeResponse` |
| **T5** | Declared lifecycle ownership + reconcile contract | Every persistent entity declares one create/refresh/prune owner and reconciles to one authoritative source each cycle. | `StaleNodeCleaner`; `network-ingestion.ts` snapshot-diff; `FactProvenanceSchema` |
| **T6** | Typed execution contract carrying status | Every result carries its own success/failure in one typed contract; no layer re-derives success from side channels (`!error`). | `ApplicationLifecycleTool.ts:70-81` (correct status promotion) |
| **T7** | Semantic acceptance enforcement per path | Every supported answer/execution path participates in a test whose fixtures make a wrong answer fail the build. | fuzz corpus (`docs/tests/`), `.pce-eval/checks.test.ts`, `domain-taxonomy-completeness.test.ts` |

### Prior-doc reconciliation
- **REVIEW.md §5** ("Intent Routing Has Zero LLM Involvement") is **stale and self-contradicted** by
  REVIEW's own §14.2/§1088. Routing is LLM-primary (`runner.ts:1062 → classifyAndRouteWithLLM`). Strike §5.
- **REVIEW.md §4** (runner monolith) confirmed and **regrown**: 3,340 → 4,433 combined LOC.
- **PARITY_AUDIT's 5 families** are Theme A pre-named; every spot-checked item re-confirmed.
- **CODE_SMELLS churn ranking** reproduced exactly; churn concentrates on the P0 files
  (`runner.ts` 3.58× rewrite ratio, `twin-query-service.ts`, `handle-execute.ts`).
- Other stale docs: `TEST_STRATEGY.md` (50→130 files), `tools.json`/`tool_definition_*` (2 vs 17 tools),
  `CLAUDE.md` ACL vocab (viewer/admin/full vs actual admin/ops/viewer/sre/security/helpdesk).

---

## 2. Decisions (RESOLVED 2026-07-23 — recommended options adopted)

| Dec | Question | Resolution | Consequence |
|-----|----------|-----------|-------------|
| **A** | CI Terraform lineage (`infrastructure.yml`, auto-approve, ephemeral state) | **Decommission** — delete the workflow (+ `ci.tfvars` if unused); README names the local `TerraformRunner` as authoritative | Eliminates AUTH-7 split-brain + AUTH-8 doc drift |
| **B** | Unauth, admin-default API on `0.0.0.0` (CAP-08) | **Fix (cheap floor)** — remove `\|\| "admin"` default (least-priv default); require a shared token; bind localhost/LAN-behind-token | **RM-06 (atomic-tool ACL) becomes a true P0** defense-in-depth |
| **C** | Plan-before-execute dead-ends at confirmation (EX-4) | **Retire** — delete `plan-generator.ts`, the plan branch, `ActionStepSchema`, `agent:plan` event, `executionPlan` state | Subsumes EX-7 (plan-gen cost) + EX-9 (dead field) — they vanish |
| **D** | Two formatting mechanisms diverged (EXPR-5) | **Sync from one source** — delete the hand-written mode prompts in `response-formatter.ts`, derive from `system-prompt.ts`; honor `AGENT_CHAT_MODEL` | Fixes land once; full path-unification deferred |
| **E** | Terraform→twin declared-provenance ingestion (AUTH-1) | **Defer** until after RM-02 | Feature, not bug; sequenced post-exposure-repair |

---

## 3. Architectural epics (decision-resolved)

Tasks nest beneath epics. **E1 and E2 are foundational; E6 is the enforcement backbone** that makes the
parity/contract invariants self-defending rather than one-time cleanups.

### E1 — One authoritative execution result  · invariants T6, T1
One typed result contract carries success/failure from action → tool → loop; no consumer re-derives it.
- **Tasks:** RM-04 shared `toExecutionResult()` in `ActionTool.execute()` (hoist the correct
  `ApplicationLifecycleTool` pattern); RM-07 retry keys off typed success, extracted from `bootstrap.ts`.
- **Deletes:** 3 copied retry loops → 1 helper; per-consumer `!result.error` derivation.
- **Affected:** `src/tools/ActionTool.ts`, `src/types/execution.ts`, `src/actions/**` runners.
- **Acceptance:** a mocked action returning `{success:false}` without throwing yields
  `ExecutionResult.error` set → a failure event, never "completed successfully"; retry fixture
  (fail-then-succeed) completes in 2 attempts.

### E2 — One graph authority with scoped lifecycle  · invariants T4, T5, T1
Isolate/scope the graph substrate; every persistent entity has one lifecycle owner that reconciles to one
authoritative source each cycle.
- **Tasks:** RM-01 scope `wipeAll()`/isolate the audit graph the way Qdrant is already isolated; RM-02 fix
  `ALLOWS/BLOCKS` once at ingestion then delete the ~8 per-method exposure workarounds; RM-12 state-rm
  recovery regenerates outputs+inventory and prunes orphaned `cloud_config`; RM-13 RAG staleness policy;
  RM-22 switch staleness, delete dead `validateGraphInvariants`, snapshot `.gitignore`, unify
  run-all/cleanup.
- **Deletes:** unscoped global-wipe reach; ~8 exposure workarounds; the duplicate run-all-orchestrators
  impl; dead `validateGraphInvariants`.
- **Affected:** `src/pce/kg/neo4j-client.ts`, `scripts/run-{gold-path,provenance-audit}.ts`,
  `src/pce/ingestion/**`, `src/twin/api/twin-query-service.ts`, `src/pce/scheduler/ingestion-scheduler.ts`,
  `src/actions/helpers/terraform-runner.ts`, `src/actions/compute/destroy-vm.ts`.
- **Acceptance:** gold-path + provenance-audit leave node counts unchanged on a populated twin;
  `internetExposedVms()` non-empty (edge count > 0) on a known-exposed fixture; a destroyed VM is absent
  from twin, `terraform output`, and `inventory.ini`.

### E3 — One authority per capability and per infra truth  · invariants T3, T2  · Decisions A, B, E
Collapse ≥4 ACL sources and 3 Terraform lineages to one each; regenerate derived artifacts; the tool
contract declares only what it implements.
- **Tasks:** RM-06 **(now P0)** finish the atomic-tool migration OR extend `ActionDefinition` with per-action
  ACL — then delete the losing path; RM-03 (Decision A) delete the CI Terraform workflow + update README;
  RM-16 scope the Terraform token off `AdminPlus`; RM-23 regenerate/diff-gate `tools.json`, fix ACL vocab;
  RM-14 fix `tool-schema.ts` `.describe()` loss so the LLM payload is faithful; RM-15 schema advertises
  only implemented diagnostics; RM-27 (Decision E — deferred), RM-28 (Ceph — deferred).
- **Deletes:** EITHER the 10 dead atomic tool classes OR the generic `ActionTool` (one owns action ACL,
  not both); the stale static JSON exports (or make them generated-only); the 2nd Terraform lineage.
- **Affected:** `src/agent/tool-loader.ts`, `src/tools/ActionTool.ts`, `src/tools/actions/*`,
  `src/actions/registry.ts`, `src/agent/tool-policy.ts`, `src/tools/tool-schema.ts`,
  `lab-infra/.github/workflows/infrastructure.yml`, `tools.json`.
- **Acceptance:** an `ops` caller is denied `compute.destroy_vm` **through** `loadTools()`+`isToolAuthorized`;
  exactly one Terraform state lineage; the LLM tool payload contains descriptions for defaulted fields.

### E4 — One canonical answer-shaping path + coverage  · invariants T1, T2  · Decision D
Collapse two formatting mechanisms and two dashboard renderers to one canonical path; every answer path
emits-or-opts-out of structured output under a completeness check.
- **Tasks:** RM-10 (Decision D) delete the mode prompts in `response-formatter.ts`, derive from
  `system-prompt.ts`, drop the hardcoded `gpt-4o-mini`; RM-11 structured output emit-or-declared-opt-out
  across the 14 `emitFinalEvent` sites + CLI reads it or is explicitly scoped out; RM-09 route the trace
  renderer through the existing `escapeHtml` (or delete its branches for the escaping generic fallback).
- **Deletes:** duplicate TERSE_DATA prompt; one renderer or its unescaped branches;
  `canonical-response-format.ts` (already TODO-delete).
- **Affected:** `src/agent/response-formatter.ts`, `src/agent/system-prompt.ts`, `src/agent/runner.ts`,
  `src/cli.ts`, `dashboard/js/reasoning.js`, `dashboard/js/response-renderer.js`.
- **Acceptance:** same query renders equivalently across dashboard/CLI/API (or declared opt-out);
  twin-first and EXECUTE answers agree on aggregate-vs-per-item scoping on identical data; an entity name
  containing markup renders inert.

### E5 — Explicit trust boundaries  · invariant T4  · Decision B
No trust-crossing op defaults to global/unsafe: authenticate identity, escape output, redact egress,
scope events.
- **Tasks:** RM-05 (Decision B) authenticate identity, drop the admin-default, bind localhost/token;
  RM-24 sanitize answer text + error logs via the existing `Redactor`/`sanitizeResponse` (resolves
  D2-EXPR-b); RM-25(sessionId) scope `emitToolProgress`; RM-09 escaping (shared with E4).
- **Deletes:** the admin-default fallthrough. No new redactor — reuse existing at the answer/log boundary.
- **Affected:** `src/pce/api/server.ts`, `src/agent/event-bus.ts`, `src/tools/**` base classes,
  `handle-execute.ts` (egress), `dashboard/js/reasoning.js`.
- **Acceptance:** no request self-asserts `admin` without a credential; a secret pasted in one turn does
  not resurface unredacted later; an SSE event without `sessionId` is not delivered cross-session.

### E6 — Semantic acceptance as a gate (backbone)  · invariants T7, T2
Every supported path is pinned by a test that fails on a wrong answer; the existing eval infra becomes a
CI gate; E1–E5's completeness tests register here.
- **Tasks:** RM-17 deterministic fixtures + fidelity assertions for the 3 weak gold-path tests; RM-18
  registration-completeness test (`loadTools()` includes each atomic tool — cheapest guard for RM-06);
  RM-19 generalize the `domain-taxonomy-completeness` pattern per family (answer-paths, entity-schemas,
  renderers); RM-20 wire `.pce-eval` + fuzz corpus as a gate (PASS-rate ≥ baseline); add a DI seam for the
  OpenAI client (EV-5) so the loop's wiring is testable.
- **Deletes:** early-return-as-pass scaffolding; live-gated dead tests; ad-hoc eval scripts → one harness.
- **Affected:** `tests/**`, `.pce-eval/**`, `docs/tests/**` corpus, CI, `handle-execute.ts` (DI seam only).
- **Acceptance:** every P0 has a regression fixture; re-running the fuzz corpus fails CI on PASS-rate
  regression; each completeness test fails when a member path omits the contract.

### E7 — Execution-path economy  · invariant T1 + size budget
Fewer, wider, cheaper execution paths; enforce a size ceiling; confirm already-fixed behavior stays fixed.
- **Tasks:** RM-08 (Decision C) retire plan-before-execute (delete `plan-generator.ts`, plan branch,
  `ActionStepSchema`, `agent:plan`, `executionPlan`); RM-25 broaden the parallel gate beyond the
  SSH-sensors special case + gate the unconditional 2nd structured-response round-trip (MEASURE first);
  RM-21 absolute size ceiling on `runner.ts`+`handle-execute.ts`; RM-26 regression re-run confirming
  MAX_STEPS residuals stay fixed (already remediated).
- **Deletes:** the entire plan-before-execute surface; the SSH-only parallel special case → general rule;
  the unconditional structuring round-trip where unneeded.
- **Affected:** `src/agent/handlers/handle-execute.ts`, `src/agent/runner.ts`, `src/agent/plan-generator.ts`
  (deleted), CI/lint.
- **Acceptance:** a composite multi-tool query issues independent tool calls concurrently; combined loop
  LOC is bounded and CI-checked; the MAX_STEPS regression corpus still passes.

---

## 4. Phased implementation sequence

| Phase | Epics | Rationale | Key tasks |
|-------|-------|-----------|-----------|
| **0 — Foundations** | E1, E2(RM-01), E6(seed) | Highest-safety, no decision needed; unblocks trustworthy signals + stops the live data-destruction bug | RM-04 (execution contract), RM-01 (graph isolation — stops the documented health-check wiping the RAG graph), RM-18 + DI seam |
| **1 — Correctness P0s** | E2, E3, E5 | The wrong-answer / infra-destroy / auth P0s | RM-02 (exposure repair), RM-03 (decommission CI Terraform), RM-05 (auth floor), RM-06 (atomic-tool ACL — now real) |
| **2 — Consolidations** | E1, E2, E3, E4, E5, E7(retire) | Collapse duplicates; land the deletions | RM-07, RM-09, RM-10, RM-11, RM-12, RM-13, RM-14, RM-15, RM-22, RM-23, RM-24, RM-25(sessionId), RM-08 (retire plan) |
| **3 — Backbone + economy** | E6, E7 | Make the invariants self-defending; trim path cost | RM-17, RM-19, RM-20, RM-21, RM-25(latency, measure-first), RM-26 |
| **Deferred (features)** | E2, E3 | Post-decision-E; after their prerequisites | RM-27 (Terraform→twin, after RM-02), RM-28 (Ceph), RM-29 (NAT edges / real reachability, after RM-02) |

---

## 5. Deletions & consolidations ledger (net-negative surface)

The resolved decisions and epics are net-subtractive. Expected removals:
- `lab-infra/.github/workflows/infrastructure.yml` (+ `ci.tfvars` if unused) — Decision A.
- `src/agent/plan-generator.ts`, `ActionStepSchema`, `agent:plan` event, `AgentStateV1.executionPlan`,
  the plan branch in `handle-execute.ts` — Decision C.
- Duplicate mode prompts + hardcoded model in `response-formatter.ts` — Decision D.
- The `|| "admin"` default in `server.ts` — Decision B.
- Either the 10 dead atomic tool classes OR the generic `ActionTool` — E3.
- ~8 per-method exposure CIDR workarounds in `twin-query-service.ts` — E2 (after root fix).
- The duplicate run-all-orchestrators implementation; dead `validateGraphInvariants` — E2.
- Stale `tools.json`/`tool_definition_*.json` (or make generated-only) — E3.
- `canonical-response-format.ts`; one dashboard renderer's unescaped branches — E4.
- Early-return-as-pass test scaffolding; live-gated dead tests — E6.
- The SSH-sensors parallel special case; the unconditional 2nd LLM round-trip — E7.

---

## 6. Provenance & completion
- Six sub-agent scopes accounted for; overlaps reconciled (REP/AUTH complementary; CAP/EXEC contract
  consistent; EXPR intent-routing = current LLM truth; EVID churn ↔ P0s align).
- No runtime mutated; no services started/restarted; no ingestion run. Temporary-resource register empty.
- Authoritative safety policy cited: `src/agent/tool-policy.ts`, `.cursor/rules/*safety*`,
  `.cursor/rules/tools-and-actions-conventions.mdc`, `src/actions/*` schemas.
- **Runtime validation is deferred by design** (planning-only). The one destructive check — verifying
  RM-01 — MUST run against a disposable Neo4j clone, never the populated production instance, because
  R-01 (the health-check graph wipe) is the bug under test.
