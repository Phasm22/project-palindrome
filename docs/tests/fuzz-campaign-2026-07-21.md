# Fuzz Campaign — 2026-07-21

**Branch:** `realAgent` @ `bcfe65d` (HEAD at campaign start)
**Scope:** End-to-end fuzz of the live Palindrome agent (`POST /api/agent/query` + SSE `/api/agent/stream`), grounded in real twin data.
**Owner:** autonomous campaign run in a single session, per the task brief.

## Artifacts

| File | Purpose |
|---|---|
| `docs/tests/ground-truth-snapshot-2026-07-21.json` | Twin snapshot (nodes/VMs/interfaces/subnets/switch/firewall rules+aliases) pulled directly from Neo4j, used to grade every response |
| `docs/tests/fuzz-corpus-2026-07-21.json` | 128 single-turn + 8 multi-turn (18 total turns) queries across 8 categories = **146 agent invocations** |
| `docs/tests/fuzz-results-2026-07-21.jsonl` | Raw captured results (request, full response JSON incl. `structuredResponse`/`rawTextFallback`, reasoning trace where available) — one JSON object per line |
| `docs/tests/fuzz-reverify-corpus-2026-07-21.json` / `fuzz-reverify-results-2026-07-21.jsonl` | Phase 7 targeted live re-verification of every fix, run twice against freshly restarted instances |
| `scripts/fuzz-campaign-runner.ts` | Reusable harness: drives the corpus against the live API via SSE, appends JSONL incrementally. `FUZZ_CORPUS_PATH=<file> bun run scripts/fuzz-campaign-runner.ts <outPath> <concurrency> [idPrefixFilter]` |
| `scripts/fuzz-campaign-summarize.ts` | Renders a JSONL results file into a compact human-readable summary |

## Methodology

- Ground truth pulled by connecting directly to Neo4j (`TwinEntity` nodes) rather than through the agent, so grading is independent of the thing under test.
- Corpus queries reference **real, live entity names** (nodes `YANG`/`yin`/`proxBig`; VMs `windowsVM`, `pihole`, `sentinelZero`, `sentinel-hunter`, etc.; switch `TJswitch`; firewall aliases `WG_VIP`, `Home_DNS`, `bogons`, ...) plus deliberately-wrong-cased/typo'd/nonexistent variants for edge cases.
- Driven via `POST /api/agent/query` (fire-and-forget, returns `sessionId` immediately) + `GET /api/agent/stream?sessionId=...` (SSE) to capture the `agent:final` event, which carries `text`, `structuredResponse`, `rawTextFallback`, `conversationState`, and `traceId`. **Note:** `docs/API_REFERENCE.md`'s description of `/api/agent/query` as synchronous (`{success, response, toolCalls}`) is stale — the real contract is async-start + SSE-final, matching what `dashboard/js/chat.js` actually does. Worth a docs fix separately (not done here, out of scope).
- Concurrency 5, with a distinct `userId` per concurrent worker (the server's `activeRunByUser` guard serializes runs per-user, so same-`userId` concurrent requests 409).
- For every non-PASS finding, pulled the full reasoning trace via `GET /api/dashboard/reasoning-traces/{traceId}` and, where the crash pre-dated any trace being recorded, cross-referenced the live server log (`logs/palindrome-api.log`) by session ID/timestamp.

## Environment

- `pc-stacks up palindrome` (with `PCE_INGESTION_ENABLED=1`) — stack was already warm-ish at session start (one stale `pce-api` process from an earlier attempt that day); restarted cleanly twice during this campaign (once to load Phase-6 fixes, once to load a fix discovered after the first restart). Neo4j data survives container recreation (named volume) — confirmed via direct Cypher checks each time.
- Ingestion scheduler confirmed healthy throughout (`proxmox`/`network`/`switch`/`topology` all `success: true` on every 5-min cycle; `firewall` reports `entities: 0` — this is `createRuleRelationships` not yet handling NAT/rdr actions, a known Phase-2 gap per the vision-gap memory, not a bug).

---

## Phase 4 — Findings by category

Legend: **PASS** correct+well-formed · **GRACEFUL GAP** known roadmap limitation, degrades cleanly · **ROUTING BUG** wrong tool/chain/regex-bypass selected · **WRONG ANSWER** contradicts ground truth · **FORMAT BREAK** data right, shape wrong · **CRASH/MAXSTEPS** unhandled exception or step-budget exhaustion.

| Category | Units | PASS | GRACEFUL GAP | ROUTING BUG | WRONG ANSWER | FORMAT BREAK | CRASH | MAXSTEPS | Other |
|---|---|---|---|---|---|---|---|---|---|
| A. Tool-surface (twin/proxmox/opnsense/ssh/diag/action) | 61 | 42 | 0 | 5 | 6 | 3 | 3 | 2 | — |
| B. Known-failure regression | 10 | 8 | 0 | 0 | 2 | 0 | 0 | 0 | — |
| C. Vision-gap probes | 10 | 3 | 4 | 2 | 1 (fixed) | 0 | 0 | 0 | — |
| D. Entity edge cases | 15 | 15 | 0 | 0 | 0 | 0 | 0 | 0 | — |
| E. Format stress | 10 | 6 | 1 | 1 | 0 | 1 | 1 | 0 | — |
| F. Composite/multi-domain | 10 | 4 | 0 | 0 | 3 (1 fixed) | 1 | 1 | 1 | — |
| H. Adversarial | 12 | 8 | 3 | 0 | 1 | 0 | 0 | 0 | — |
| G. Multi-turn (8 flows) | 8 | 4 | 0 | 0 | 1 | 0 | 0 | 0 | 3 partial-continuity |
| **Total (136 units / 146 invocations)** | | **90** | **8** | **8** | **14** | **5** | **5** | **3** | **3** |

**Headline:** the single largest, highest-leverage bug class was **CRASH** — every crash in the campaign (5 in the original run, plus 2 more surfaced while re-verifying other fixes = 7 distinct instances) traced to exactly **two root causes**, both fixed (§ Phase 6). After the fix, **0/16** targeted live re-verification queries crash; the worst remaining outcome for a previously-crashing query is a clean `MAXSTEPS` message.

---

## Phase 5 — Root-cause map

### Fixed this session (Phase 6)

#### 1. CRASH — `executeToolCall` doesn't catch tools that `throw` instead of returning `{error}`
**File:** `src/agent/tool-executor.ts`
**Evidence:** `A-TQ-11`, `A-PX-06` (original run), reproduced live 2x more in isolation (`repro-test-1`, `RV-CRASH-01`).
**Root cause:** `tool.execute()` was awaited with no `try/catch`. Several read-only tool actions (e.g. `proxmox_readonly`'s `node_disks`/`node_network_interfaces`) validate required params via `throw new Error(...)` rather than returning `{ error }`. An uncaught rejection propagates through `handleExecute` → `runAgent` → the top-level `.catch()` in `server.ts`, which emits `"The agent run failed before it completed."` — bypassing tool-error handling, failure-reclassification, and graceful degradation entirely.
**Fix:** wrap the `tool.execute()` call in try/catch, converting a thrown error into a normal `{ error }` `ExecutionResult` (matching the contract every caller already expects).
**Test:** `tests/agent/tool-executor.test.ts` (async throw, sync throw, healthy-tool passthrough, unknown-tool passthrough).

#### 2. CRASH — mid-batch `context.addUserMessage()` breaks OpenAI's tool_calls ordering contract
**File:** `src/agent/handlers/handle-execute.ts`
**Evidence:** `A-TQ-11`, `A-OP-06`, `E-03`, `F-05` (original run); `RV-ASKMISSING-01`, `RV-CRASH-01`, `RV-CRASH-05` (surfaced again while re-verifying other fixes, with fresh session IDs at a different time — confirmed **reliably reproducible**, not transient).
**Root cause — root-caused via `logs/palindrome-api.log` line-by-line trace, not guesswork:** when the LLM emits 2+ `tool_calls` in one turn and the *first* one fails, the failure-reclassification block calls `context.addUserMessage(...)` **immediately, inside the per-tool-call loop** — before the *remaining* tool_calls in the same batch have been processed. Since the assistant message carrying *all* `tool_calls` for the turn is pushed to context once, up front, this inserts a `user` message between two `tool` response messages that both belong to the same assistant turn. OpenAI's Chat Completions API rejects the *next* call with exactly the observed 400: `"An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'."` This is the failure-reclassification loop-risk that REVIEW.md §4 flagged in the abstract (*"reclassifyIntentWithContext() is called, which modifies the agent context (adds messages)"*) — this campaign found the concrete, reproducible manifestation.
**Fix:** collect the reclassification follow-up message(s) in a local array during the loop; flush them via `context.addUserMessage()` only *after* every `tool_call_id` in the batch has received its tool-role response.
**Test:** not unit-tested — `handleExecute` has no existing test seam (30+ required input fields, module-level singleton OpenAI client, no dependency injection for `tools`/RAG/twin) and the one existing test file that exercises this function (`tests/agent/runner-confirmation-flow.test.ts`) already does so via live `runAgent()` + live OpenAI calls (consistent with this file's existing convention, but not one to add to per the "no live infra in unit tests" rule). **Verified instead via live re-verification** (Phase 7): reproduced the crash 100% (3/3 attempts across 2 separate live sessions before the fix), then confirmed 0/16 crashes after. This is flagged explicitly, not glossed over — see "What I did not unit-test" below.

#### 3. ROUTING BUG — `isClearInformationalQuery()` bypass has gaps, so an LLM classification "bad day" falls into a broken clarification loop
**File:** `src/reasoning/intent-router.ts`
**Evidence:** `A-TQ-01` ("Give me a summary of the whole cluster."), `A-SSH-03/04/06` (ping/traceroute/health-diagnostic imperatives), `A-DIAG-01` ("why can't I reach pihole"), `E-10` ("vms???? on yang???? pls?????").
**Root cause:** `classifyAndRouteWithLLM()` already has a deliberate regex-based safety net (`isClearInformationalQuery()`) for exactly this failure mode (comment: *"Bypass clarification for clear informational questions so we don't ask 'observe, diagnose, change, or explain?'"*), but its pattern list only covers `show/tell/list/describe/what/which/is/are` phrasings. It doesn't cover `"give me"` (extremely common), imperative diagnostic verbs (`ping X`, `traceroute to X`, `diagnose X`), or loose punctuation-heavy phrasing. When the LLM classifier (non-deterministic, `gpt-4o-mini`) has a low-confidence day for one of these gapped phrasings, there's no net, and the user gets the generic "Are you asking to observe, diagnose, change, explain, or plan?" instead of an answer.
**Fix:** extended the pattern list with `give|gimme`, `^(ping|traceroute)`, `check/run + diagnostic/health/...`, `diagnose`, `summar(y|ize)`, and a loose `<entity noun> ... on <target>` catch-all.
**Test:** `tests/reasoning/classify-and-route-conversation.test.ts` (all 6 previously-broken phrasings now bypass clarification; confirmed the test fails without the fix).
**Caveat (see Phase 7):** this is a *backstop*, not a guarantee — it only fires when `routing.route === "clarification"` is reached in the first place. `C-08` ("Would deleting the bogons alias break anything?") and a couple of others in category C still occasionally hit a *different* generic clarification wording (`"What do you want to do next..."`, from the `missing: ["intent"]` path in `handle-clarify.ts`/`AskMissingTool.ts`) that my regex list doesn't cover. Not fixed — flagged as a residual, lower-priority follow-up since it's LLM-day-dependent, not 100%-reproducible.

#### 4. WRONG ANSWER — `extractAliasName()` greedily swallows the rest of the sentence
**File:** `src/reasoning/detectFirewallIntent.ts`
**Evidence:** `F-10` — *"What VMs would be affected if the WG_VIP alias were removed, and are any of them internet-exposed?"* → agent replied *"No alias named `were removed, and are any of them internet-exposed` was found..."*
**Root cause:** the `alias\s+(.+?)(?:contents?|members?|entries?|[.?!]|$)` regex has no bound on ordinary continuation words (`were`, `and`, `removed`, ...), so once "alias" isn't immediately followed by a terminator, it captures until the next period/question-mark — i.e. the rest of the sentence. There was also **no support at all** for the (more natural English) "**the X alias**" word order — only "alias X" and quoted variants.
**Fix:** (a) added a preceding-token pattern (`"the WG_VIP alias"` → `WG_VIP`), tried first; (b) added a stopword-based truncation for the existing forward/backward patterns so a greedy capture stops at the first non-name word; (c) added a guard excluding impact/removal-flavored questions (`break|removed|deleted|affect|impact`) from the "show contents" `alias_contents` branch entirely, so `F-10`-style compound impact questions fall through to the EXECUTE/LLM path (which can actually reason about the compound "impact + exposure" question) instead of the narrow contents-lookup chain. Verified this guard doesn't regress the pre-existing, working `A-TQ-20`/control case (*"What would break if I deleted the Home_DNS alias?"*).
**Test:** `tests/reasoning/detect-firewall-intent.test.ts` (3 new cases; confirmed 2/3 fail without the fix).

#### 5. FORMAT BREAK — `normalizeCountPackaging()` discards real data when it can't parse a bare count
**File:** `src/agent/response-formatter.ts`
**Evidence:** `E-04` — *"List all firewall aliases and how many entries each one has."* → chain correctly computed `"Firewall Rule Count\n- total | Count=104 | PASS=71 | BLOCK=24 | NAT=9"`, but the response the user actually saw was the bare title **`"Firewall Rule Count"`** — every number silently discarded.
**Root cause:** `isCountQuery()` is a blanket `/\bhow\s+many\b/` test with no domain restriction, so it fires on this multi-attribute breakdown question. `normalizeCountPackaging()` then tries (and fails) to extract a single VM/node/container-shaped count from the text, and its fallback was `return lines[0] ?? trimmed;` — i.e. "if in doubt, keep only the title line."
**Fix:** changed the fallback to `return null` (don't touch the response; let normal formatting/passthrough handle it) instead of destructively truncating. Also widened the unit vocabulary (`rules?|aliases?`) for the cases that *do* have a real single count to extract.
**Test:** `tests/agent/response-formatter-adaptive.test.ts` (2 new cases: one confirming the destructive-truncation regression is gone, one confirming genuine single-count extraction still works; confirmed the first fails without the fix).
**Residual, not fixed:** the underlying chain-selection is still semantically wrong for this exact phrasing — `detectFirewallIntent`'s `isCountQuery` routes *any* "how many" phrasing to `count_rules` (rule counting) regardless of whether the user asked about rules, aliases, VMs, or anything else, so `E-04` still gets a rule-count answer instead of a per-alias breakdown. That's a distinct, lower-priority routing gap (needs "count of *what*?" disambiguation, more corpus evidence before a confident fix) — flagged, not fixed.

#### 6. WRONG ANSWER (UX) — `ask_missing`'s LLM fallback echoes raw parameter names to the user
**File:** `src/tools/AskMissingTool.ts`
**Evidence:** `C-10` — *"Which assets have an undocumented path between the home and lab trust zones?"* → *"What is the fromId for the asset in question?"* (leaked the internal `fromId` field name verbatim).
**Root cause:** the tool has deterministic fast-paths for common missing slots (`intent`, `target/node/host`, `vmid`, `name`, `type`) but anything else falls through to a generic LLM call whose system prompt doesn't instruct it to avoid parroting the raw slot name back — and for a slot like `fromId` the small model just... didn't.
**Fix:** added fast-path mappings for `fromId/sourceId`, `chain/interface`, `subnet/cidr`, `ruleId/rule`, `alias/aliasName`, plus an explicit "never mention internal parameter names verbatim" instruction on the remaining LLM-fallback system prompt for anything still unmapped.
**Test:** `tests/tools/ask-missing-tool.test.ts` (6 cases covering all 4 new mappings plus 2 existing behaviors, unaffected).

### Found, prioritized, **not fixed** (flagged for follow-up)

| Finding | Where | Why not fixed here |
|---|---|---|
| `A-TQ-10`/`A-TQ-16`/`A-TQ-19`: `network_vms_by_subnet`, `firewall_rules_blocking_subnet`, `firewall_reachability_from_chain` return "not found" when ground truth clearly has matches | `src/twin/api/twin-query-service.ts` (the underlying Cypher for these 3 ops) | Needs Cypher-level debugging with query-plan visibility I didn't have time to safely acquire without risking a bad edit to a widely-shared query file; each is an independent root cause, not a single fix. Concrete repro queries are in the corpus for a future session. |
| `A-OP-02`/`A-OP-09`: "list aliases" and "routing table" questions get answered with firewall-rules-dump / interface-list respectively | Tool-selection in the EXECUTE-path LLM loop, likely `system-prompt.ts` tool guidance for `opnsense_readonly` | LLM tool-choice issue, not a deterministic code bug — would need prompt-engineering + a larger corpus to validate a fix doesn't regress other opnsense_readonly routing. |
| `A-TQ-22`, `A-TQ-21`/`A-TQ-23`: exposure questions scoped to one VM return the *entire* exposure map (self-contradictory in `A-TQ-22`'s case: says "None VMs exposed" then lists several) | `exposure_vm_analysis`/`exposure_vms_by_subnet` op formatting in `TwinQueryTool.ts` or the twin-query-service equivalent | Real bug, but the exact formatting logic needs a closer read than time allowed this session; flagging with a strong repro is more valuable than a rushed partial fix. |
| `B-06`: `"what is enx000ec698587a?"` (generic phrasing, no "network interface" framing) gets a hallucinated description instead of real twin data, vs. `B-05`/`B-07` (with "network interface" framing) which now work correctly | `detectNetworkIntent.ts` — the phrase-matching for MAC-style `enxXXXXXXXXXXXX` names is narrower than the "what is X" generic phrasing | Partial fix already landed upstream (this campaign confirmed `B-05`/`B-07` now work); the remaining phrasing gap is a smaller, separate regex extension similar to fix #3 above — good next-session candidate. |
| `B-09`: `"what's the uptime of WindowsVM?"` (mixed case) returns `uptime=unknown` while lowercase/correct-case return the real value | LLM tool-choice variance (sometimes picks `get_vm_config` instead of an uptime-bearing op) | Not a deterministic code bug — same underlying VM is found correctly (case-insensitivity itself works, contrary to the original expectation that this was still broken); only the *specific metric* returned varies by LLM day. |
| `F-02`: *"List all nodes and their exposure level."* → *"Which VMID is this for?"* | LLM picks a single-VM-scoped `exposure_vm_analysis` tool call for a cluster-wide question | Same class as `A-OP-02`/`A-OP-09` above — tool-choice, not code. |
| `F-04`: node VM-count comparison across 3 nodes returns wrong counts (yang shown as 2, actually 5; yin shown as 0, actually 3) | LLM aggregation across multiple tool calls in the EXECUTE path | Inherent to `gpt-4o-mini` multi-tool synthesis without a structured aggregation step; not fixable with a small deterministic patch. |
| `F-06`: raw pfctl rule syntax (`"scrub in all fragment reassemble"`, `"block drop in log on ! vtnet1..."`) dumped unformatted into a composite exposure+firewall answer | EXECUTE-path formatting for a `proxmox_readonly`/`opnsense_readonly` composite call, likely bypassing `applyAdaptivePackaging` because the intent isn't classified as `firewall_rules` | Needs the same kind of `intentType` plumbing fix #5 touches, but for a different call site; deferred to keep this session's diff small. |
| `H-05`: a Cypher-injection-flavored VM name (`"' MATCH (n) DETACH DELETE n //"`) caused the agent to attempt a real `compute.destroy_vm` action against **`windowsVM`** specifically (caught safely by the pre-existing Terraform-state check: *"was not present in Terraform's destroy plan"* — no actual damage) | Classification picking up on the literal word `DELETE` in the adversarial string | **Flagging prominently for TJ's judgment call, not attempting a fix.** The safety net held (no VM was actually touched), but the fact that injection-flavored text containing `DELETE` gets classified as a genuine destroy-VM *action* attempt — and that it silently substituted an unrelated real VM name (`windowsVM`) rather than the (nonexensistent) name in the injection string — deserves a closer security-flavored look before deciding what "correct" behavior should be here. |
| `G-08`: user says "call me Ripley", agent confirms; very next turn "what's my name?" gets "I don't have your name yet" | `src/agent/handlers/handle-identity.ts` / `identity-helpers.ts` — `extractUserNameUpdate` sets it, but the persisted `conversationContext` apparently isn't read back correctly (or the accepted-phrasing set for the *query* path is narrower than for the *update* path) | Reproducible, real bug, but identity/session persistence touches server-side conversation-context storage (`src/pce/api/server.ts`) that's riskier to patch quickly without a wider test pass; flagged for a dedicated session. |
| `G-01`/`G-02`/`G-04`: multi-turn clarification-continuation and entity-resolution-cache are inconsistent — sometimes "YANG" after a clarifying question correctly continues the create-VM flow (per `docs/observability-reasoning-traces.md`'s worked example), sometimes it doesn't and the agent asks a second, unrelated clarifying question | `src/agent/handlers/clarification-continuation.ts` + entity cache wiring in `handle-execute.ts` | This is exactly REVIEW.md §8/Gap 2 ("Re-Classification Tax") — a known, called-out architectural gap requiring the typed inter-turn state REVIEW.md recommends, not a small patch. Roadmap, not a bug to spot-fix. |
| `C-01`/`C-03`: VLAN-50-reachability and port-8006-rule-attribution questions return real, correct *raw* data (switch ports; full rule list) but don't scope/synthesize it into a direct answer to the actual question asked | Chain selection in `detectNetworkIntent.ts`/`detectFirewallIntent.ts` picking a "list X" op instead of the more specific op that already exists (`switch_ports_by_vlan` for C-01; the port-8006 rule *is* in `firewall_list_rules`'s output for C-03, just not filtered/attributed) | Both are close to working — the data is right there — but scoping them correctly needs the query's specific filter (VLAN number, port number) threaded through to the right op, similar in shape to fixes #3/#4 above. Good next-session quick wins. |

### Vision-gap probes — graceful vs. broken (as instructed, not "fixed")

Per the task's framing, Phase 2/3/4 roadmap gaps are **not bugs**. Assessed:

- **Genuinely graceful** (asks a reasonable clarifying question or states the limitation, no hallucination, no crash): `C-02` (VPN→Pi-hole path), `C-05` (DNS dependents — Pi-hole not ingested), `C-09` (windowsVM-vs-sentinelZero reachability asymmetry — gives a plausible qualitative answer while implicitly working within same-subnet-only reachability).
- **Genuinely graceful, now much better than before this session's fixes:** `C-10` (undocumented trust-zone paths) — was leaking `fromId` verbatim (fixed #6), now cleanly hits `MAXSTEPS` instead.
- **Not broken, but not "graceful" either — a residual routing gap** (real data exists and is close, just not scoped to the question): `C-01`, `C-03` (see table above).
- **Working correctly** (Phase 0/1 capabilities, confirmed live): `C-06` (switch trunk port → correctly identifies `Gi0/33`/`Gi0/34`), `C-07` (WAN exposure inventory), `C-04` (blast-radius qualitative answer for "yin goes down").

---

## Phase 6 — Fixes shipped (uncommitted, for review)

| File | Change | Test added |
|---|---|---|
| `src/agent/tool-executor.ts` | try/catch around `tool.execute()` | `tests/agent/tool-executor.test.ts` (new) |
| `src/agent/handlers/handle-execute.ts` | defer failure-reclassification `addUserMessage()` until the full tool_calls batch has responses | *(see "what I did not unit-test" above; verified live)* |
| `src/reasoning/intent-router.ts` | expanded `isClearInformationalQuery()` patterns | `tests/reasoning/classify-and-route-conversation.test.ts` (extended) |
| `src/reasoning/detectFirewallIntent.ts` | fixed `extractAliasName()` greedy capture + preceding-token support + impact-question guard | `tests/reasoning/detect-firewall-intent.test.ts` (extended) |
| `src/agent/response-formatter.ts` | `normalizeCountPackaging()` no longer destructively truncates on failed extraction | `tests/agent/response-formatter-adaptive.test.ts` (extended) |
| `src/tools/AskMissingTool.ts` | added plain-English mappings for `fromId`/`chain`/`subnet`/`ruleId`/`alias` slots | `tests/tools/ask-missing-tool.test.ts` (new) |

**Verification run:**
- `bun run --bun tsc --noEmit` — clean, both before and after every change.
- `bun test` (full suite, twice — once with fixes, once on a clean stash as baseline) — **640 pass / 66 fail / 11 skip** with fixes vs. **629 pass / 71 fail / 11 skip** on baseline. Diffed the two failure-name sets directly: every failure in the "with fixes" run is either (a) an environment-dependent test needing live Proxmox/OPNsense credentials not configured in this sandbox (`TL-2A.1`/`TL-2A.2`/`TL-2A.4`/`TL-2A.6.A` suites — present in both runs, identical), or (b) already-known-flaky live-LLM-call tests (`runner-confirmation-flow.test.ts`, `runner-mvs.test.ts`, `phase-ic-dod.test.ts`) — confirmed flaky **independent of my changes** by running each in isolation 2-3x and observing different specific sub-tests fail each time (matches REVIEW.md §14.3 P0.2's documented, still-open "full-suite stability under concurrent Bun load" issue). **Zero new deterministic regressions** attributable to this session's diff.
- My 6 fixes' own test files (24 new/extended test cases across `tool-executor.test.ts`, `ask-missing-tool.test.ts`, `classify-and-route-conversation.test.ts`, `detect-firewall-intent.test.ts`, `response-formatter-adaptive.test.ts`) each independently confirmed to **fail on the pre-fix code** (via `git stash push -- <file>` + rerun) and **pass on the fixed code**.

---

## Phase 7 — Live re-verification

Ran a dedicated 16-query re-verification corpus (`fuzz-reverify-corpus-2026-07-21.json`) against the live stack **twice**: once immediately after landing fixes #1/#3/#4/#5/#6 (before fix #2 was discovered — 3/16 still crashed), and again after landing fix #2 and a full stack restart (0/16 crashed). Stack was restarted cleanly both times (`pc-stacks up palindrome` after a `docker compose down` to clear a stale network from the abrupt earlier kill) with twin data confirmed intact via direct Cypher check each time (Neo4j uses a named volume, survives container recreation).

| Query | Pre-fix (original run) | Post-fix (final live re-verify) |
|---|---|---|
| "Give me a summary of the whole cluster." | Generic "observe/diagnose/change?" clarification | ✅ Full cluster summary with per-node VM counts + memory usage |
| "Ping 172.16.0.1 for me." | Same generic clarification | No longer clarification-looped; now a (separate, unfixed) tool-declined response — **routing bug fixed, secondary tool-choice issue remains** |
| "Traceroute to 8.8.8.8." | Same generic clarification | No longer clarification-looped; now `MAXSTEPS` after 4 real tool attempts — **routing bug fixed, secondary tool-arg issue remains** |
| "Run a full health diagnostic on windowsVM." | Same generic clarification, *then* falsely claimed no info existed for windowsVM | No longer clarification-looped; now `MAXSTEPS` after 12 real tool attempts (was previously giving up after 1) — **clear improvement, not fully resolved** |
| "vms???? on yang???? pls?????" | Same generic clarification | ✅ Correctly lists YANG's VMs |
| "What's in the WG_VIP alias?" | (Not tested — new capability) | ✅ Correctly resolves via new preceding-token support: `Alias WG_VIP contains one entry: 10.16.0.0/29` |
| "What would break if I deleted the Home_DNS alias?" (control) | ✅ Reasonable EXECUTE-path answer | ✅ Unchanged — confirms no regression from the alias-impact guard |
| "What VMs would be affected if the WG_VIP alias were removed, and are any of them internet-exposed?" | `"No alias named 'were removed, and are any of them internet-exposed' was found"` | ✅→`MAXSTEPS` across the two re-verify passes (first pass got a fully correct, grounded answer citing the real `10.16.0.0/29` CIDR; second pass hit the step budget mid-reasoning) — **the garbled-name bug is gone either way; remaining variance is inherent to a genuinely hard 2-part composite question** |
| "List all firewall aliases and how many entries each one has." | `"Firewall Rule Count"` (all data silently discarded) | ✅ `"Firewall Rule Count - total \| Count=104 \| PASS=71 \| BLOCK=24 \| NAT=9"` — **destructive truncation confirmed fixed**; semantic mis-routing (counts rules not aliases) is the separate, documented residual finding |
| "Which assets have an undocumented path between the home and lab trust zones?" | `"What is the fromId for the asset in question?"` (raw param leak) then, on reproduction, **CRASH** | No param leak; `MAXSTEPS` — **both issues resolved** |
| "Can something on 172.16.0.0/22 reach 192.168.68.0/22?" | **CRASH** (reproduced 2/2 in isolation before fix #2) | **0/1 crash** after fix #2 — `MAXSTEPS` instead |
| "What disks are attached to proxBig?" | **CRASH** | ✅ Full disk data returned |
| "What's the system status of the OPNsense box?" | **CRASH** | `MAXSTEPS` (no crash) |
| "List every network interface on every node." | **CRASH** | ✅ Full interface data returned |
| "For every stopped VM, tell me which node it's on and whether any firewall rule references it." | **CRASH** | `MAXSTEPS` (no crash) |

**Crash tally: 7/16 → 0/16.** No fix regressed a previously-passing case.

**Disposable-VM lifecycle test:** not performed. None of the 6 fixes required live compute-provisioning to verify (all are read-path/formatting/classification fixes); per the task's own framing this sub-task was optional and scoped to "only if you have a specific fix that needs live compute-provisioning verification."

**Dashboard-level confirm-button check (`B-04-dashboard`):** verified at the code level (`dashboard/js/chat.js`'s `pendingConfirmationActive` guard from commit `bcfe65d` is present and matches the described fix) and at the API level (`AWAITING_CONFIRMATION` state + `CONFIRM <id>`/`CANCEL` prompt returned correctly, both in the original fuzz run and in a fresh live check). Did not additionally drive a headless browser against `dashboard:serve` — the task marked this as one of "2-3 representative cases, not required for all," and the code+API evidence is unambiguous for this specific, narrowly-described bug.

---

## What I chose not to fix, and why (summary)

- **Roadmap gaps** (Phase 2/3/4 per `lvl3-vision-gap-plan.md`): NAT/route firewall edges, real reachability evaluation, Pi-hole ingestion. Confirmed these degrade gracefully rather than break, per the task's explicit instruction not to build roadmap capability in this pass.
- **LLM tool-choice variance** (`A-OP-02`, `A-OP-09`, `F-02`, `F-04`, `B-09`): not deterministic code bugs; fixing would mean prompt-engineering with a much larger validation corpus than one session allows, risking regressing other tool-choice behavior.
- **Multi-turn conversational-state architecture** (`G-01`, `G-02`, `G-04`): exactly REVIEW.md's flagged, large, deliberately-out-of-scope architectural gap (typed inter-turn state).
- **`G-08` identity persistence, `A-TQ-10`/`16`/`19` twin-query op bugs, `A-TQ-21`/`22`/`23` exposure-scoping, `F-06` raw-pf-dump formatting, `C-01`/`C-03` scoping, `B-06` MAC-lookup phrasing gap:** real, reproducible, independently-scoped bugs — each would be a reasonable, small, correct diff on its own, but doing all of them properly (with tests) in this session would have meant less rigor on the ones I did fix and verify live. Prioritized the highest-blast-radius fixes (2 crash root causes affecting ~7 distinct queries + 1 routing bug affecting ~6 queries) over breadth.
- **`H-05`** (injection string → real destroy_vm attempt against an unrelated VM, safely caught by Terraform-state check): flagged for TJ's judgment call rather than a unilateral fix, since "what should classification do with adversarial text containing `DELETE`" is a product/security decision, not just a bug.
