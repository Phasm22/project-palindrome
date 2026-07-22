# Code-Smell Audit

**Date:** 2026-07-22

**Scope:** `src/`, `scripts/`, and a cross-module sample of `tests/`

**Method:** Git churn (`git log --oneline --follow -- <file>`), patch-history sampling,
static inspection, and test-assertion fidelity review. This is a diagnostic, not a
refactoring plan.

## Executive summary

The highest-risk findings are not cosmetic:

1. Three independently implemented Ansible service actions advertise retries that do
   not execute. Their first failed command throws out of the retry loop; the equivalent
   bootstrap implementation does not have this bug.
2. Real-time ingestion acknowledges delete events as complete without deleting
   anything. This creates durable stale data while telling the queue the event succeeded.
3. The runner extraction has materially regressed. `runner.ts` grew from 1,951 lines at
   the March extraction to 2,275, while `handle-execute.ts` grew from 1,389 to 2,158.
   The two hot-path functions are now about 3,420 lines combined.
4. `SSHTool.ts`, `handle-execute.ts`, `response-formatter.ts`, and
   `twin-query-service.ts` show genuine reactive patch cycles. These are not simply busy
   files: recent patches repeatedly add special cases after live behavior contradicts
   an earlier assumption.
5. Several tests named as end-to-end or gold-path checks only require a non-empty string,
   optional provenance, or any tool invocation. They would pass while returning the
   wrong VM, wrong policy recommendation, or corrupted source data.

No production code was changed during this audit. The two pre-existing modified snapshot
files were left untouched.

## 1. Churn ranking

### Method and exclusions

For every Git-tracked file under `src/` and `scripts/`, I counted:

```sh
git log --oneline --follow -- <file> | wc -l
```

I excluded `src/reasoning/*.ts` and `src/agent/tool-loader.ts` from the ranking. I kept
`runner.ts` in order to assess monolith regrowth, but ignored its classifier-adjacent
changes when assigning the disposition below. Recent patches were sampled with
`git log -p --follow` rather than classifying from filenames or commit counts alone.

One measurement caveat matters: `--follow` attributes 48 historical `runner.ts` commits
to `runner.ts.bak`, although the backup was actually added once in `79c1303`. This is a
copy/follow artifact, not 48 edits to the backup. The artifact itself is still a smell:
the repository carries a 3,246-line stale source snapshot.

### Top 20 and why they change

| Rank | Commits | File | History-based disposition |
|---:|---:|---|---|
| 1 | 66 | `src/agent/runner.ts` | **Mixed, now structural smell.** Feature coordination is expected, but non-classifier additions keep returning to the coordinator (application lifecycle, connection verification, response rendering). It is 2,275 lines and `runAgent()` spans `runner.ts:800-2275`. |
| 2 | 48* | `src/agent/runner.ts.bak` | **Measurement artifact and dead snapshot.** Added once by `79c1303`; its apparent history follows the source copy. A 3,246-line backup does not belong in the source tree. |
| 3 | 36 | `src/agent/system-prompt.ts` | **Mixed.** Much is normal capability growth, but correctness is also being patched into prose: `596ecff` added a highly specific aggregate-vs-item instruction after a live data-merging failure (`system-prompt.ts:70-74`). That is a weak enforcement boundary for a data-shape invariant. |
| 4 | 36 | `src/pce/api/server.ts` | **Mostly organic feature growth, with monolith risk.** Dashboard, history, graph, ingestion, and agent routes accumulate in one 2,720-line class. Recent switch/topology additions (`16a2ac3`, `d7f4216`) are linear features, not a bug-fix cycle, but every API concern lands in the same file. |
| 5 | 24 | `src/tools/proxmox/readonly/proxmox-readonly-tool.ts` | **Mixed.** Many new read operations are expected. `c4909a5` added an endpoint cache after repeated per-entity `/nodes` scans caused unrelated timeouts; the current class remains a 2,267-line action dispatcher, so cross-action resource behavior is hard to see. |
| 6 | 21 | `src/cli.ts` | **Mostly organic/legacy growth.** Commands, streaming, and confirmation support accumulated linearly; the last change was February. No recent reactive cycle was found. |
| 7 | 17 | `src/actions/compute/create-vm.ts` | **Mostly organic safety and capability growth.** Template/storage discovery, lifecycle use, and connection verification explain most changes. `fdae323` fixed cluster Terraform authentication, but the sampled history does not show a repeated same-area fix-of-fix cycle. |
| 8 | 17 | `src/tools/proxmox/writes/proxmox-write-tool.ts` | **Mostly organic operation growth.** VM/LXC actions and preflight checks accumulated together. Its 1,540 lines are a traditional size concern, but recent history does not show the same reactive cycle as SSH or response formatting. |
| 9 | 17 | `src/twin/api/twin-query-service.ts` | **Reactive correctness smell plus feature growth.** `0d27f38` added new switch queries and safer deletion semantics; hours later `b8cdc34` changed 367 lines here to fix CIDR equality, literal-vs-alias rule resolution, unrestricted-destination reachability, exposure scoping, and port substring false positives. One 2,151-line query service owns many unrelated Cypher semantics. |
| 10 | 15 | `src/tools/SSHTool.ts` | **Strong reactive cycle.** Cisco support in `13095fe` explicitly shipped while the desired live command still failed; `9b66ddb` added an interactive state machine 31 minutes later; `8f6338d` fixed a process-liveness hang five minutes after that; `7365d62` fixed `includes("172.16.0.1")` routing Proxmox hosts through OPNsense logic; `956eef3` then described its socket fix as “partial — does not fully close the hang.” |
| 11 | 14 | `src/agent/handlers/handle-execute.ts` | **Strong reactive cycle and extraction regrowth.** `45d1988` added dynamic step budgets and an empty-step guard but documented duplicate-call and boundary-synthesis residuals; `c9fdabb` added 153 more lines two hours later to handle exactly those residuals. The exported `handleExecute()` now spans `handle-execute.ts:215-2158`. |
| 12 | 14 | `src/tools/TwinQueryTool.ts` | **Mostly paired feature growth, with change-multiplier evidence.** Each new twin operation requires matching dispatch/schema code here and query code in `twin-query-service.ts`; both `0d27f38` and `b8cdc34` touched both files. The smell is the parallel operation registry, not each individual change. |
| 13 | 13 | `src/agent/response-formatter.ts` | **Strong reactive heuristic accretion.** `2d7b38f` fixed destructive truncation of unrecognized count responses (`response-formatter.ts:236-266`); hours later `45d1988` added an 84-line raw-pfctl recognizer/reformatter for another observed output shape (`response-formatter.ts:640-720`). The 1,447-line formatter still parses and rewrites prose through regexes and thresholds. |
| 14 | 11 | `src/tools/opnsense/readonly/opnsense-readonly-tool.ts` | **Mostly organic action growth.** Firewall, interfaces, system, diagnostics, and DHCP were added linearly. `91c1e52` changed parallel SSH collection to sequential because the forced menu cannot safely handle competing channels; this is a legitimate protocol constraint, not a repeated bug cycle. |
| 15 | 10 | `src/actions/helpers/terraform-runner.ts` | **Mixed but not a demonstrated cycle.** State-path support and application lifecycle options are expected growth; `fdae323` corrected cluster-token selection. The larger concern is command-string construction and a 954-line helper, covered below. |
| 16 | 10 | `src/config/approved-commands.yaml` | **Expected configuration growth.** Host and command allowlists naturally change with supported infrastructure. Its two July commits mirror the Cisco SSH discovery/fix, but the configuration file is not the root cause. |
| 17 | 10 | `src/pce/api/reasoning-trace-store.ts` | **Expected schema evolution, but coupled to execute policy.** It repeatedly gains decision variants whenever `handle-execute.ts` adds control-flow states (`45d1988`, `c9fdabb`) and gained caller-supplied IDs in `858b3c7`. This is a change multiplier worth replacing with a stable discriminated trace event contract. |
| 18 | 10 | `src/pce/rag/hybrid-orchestrator.ts` | **Early stabilization followed by low churn.** The 2025 history includes the direct fix `5540bbe` (“ensure hybrid context is always injected”), but sampled later patches are ordinary cache/fallback evolution. No recent fix-of-fix cycle was found. |
| 19 | 10 | `src/pce/vector/qdrant-client.ts` | **Mostly organic stabilization.** Collection-name centralization and guards against chunk/vector length mismatch explain recent changes. No recurring patch pattern was found. |
| 20 | 10 | `src/tools/ActionTool.ts` | **Expected registration/documentation evolution.** The important old smell—hand-maintained action parameter prose—was removed by `3537c4b`, which derives it from schemas. Recent taxonomy metadata is linear growth. |

### Highest-risk churn diagnoses

#### P1 — `SSHTool.ts` is several transports and state machines hidden behind one tool

The current file owns an ssh2 connection pool (`SSHTool.ts:46-151`), pooled exec,
OPNsense forced-menu shell behavior, system OpenSSH/sshpass, and a bespoke Cisco
privileged-EXEC state machine (`SSHTool.ts:509-617`). Host selection, policy expansion,
credentials, connection lifecycle, prompt recognition, and output parsing therefore
change together.

The July 21 sequence above is the closest non-classifier match to the reactive pattern in
`CLASSIFICATION_STANDARDS.md`: one capability addition immediately exposed wrong transport
assumptions, event-loop leaks, substring-based host misrouting, and incomplete socket
cleanup. Extract transport strategies with an explicit host capability (`exec`,
`forced-menu`, `legacy-interactive`) and give each lifecycle tests that assert process exit
and cleanup.

#### P1 — step-budget behavior is being patched inside a 1,944-line function

`computeMaxSteps`, `isStuckOnEmptyStep`, and `isDuplicateOnlyStep` are individually named,
but their state is updated throughout the main tool loop (`handle-execute.ts:785-831`,
`:982-1034`, `:1815-1858`) and synthesized again at the boundary (`:2056-2144`). The
`45d1988` → `c9fdabb` sequence shows the abstraction gap: “empty,” “duplicate-only,”
“successful,” and “synthesizable” progress were discovered one live failure at a time.
Model step productivity as one typed result emitted by tool-batch execution; the budget
controller should consume that result rather than reconstruct progress from scattered
counters.

#### P1 — response correctness still depends on recognizing prose shapes

`normalizeCountPackaging()` correctly stopped discarding unrecognized data after
`2d7b38f`, but the fix is still a regex fallback (`response-formatter.ts:236-266`). The
pfctl fix in `45d1988` similarly detects quoted or bare firewall prose and rewrites it
(`:640-720`). The current formatter then has more heuristic gates and a second LLM
formatting pass (`:1302-1407`). Continue the existing structured-response migration so
tool results are formatted from typed fields; do not add another output-shape recognizer
for the next live example.

## 2. Structural duplication

### P0 — three copied retry loops never retry

`installNginx`, `setStaticIp`, and `configureFirewall` each declare
`retryOnFailure`, `maxRetries`, `lastResult`, and a retry loop. In all three, a failed
ad-hoc command is caught and immediately rethrown out of the enclosing function:

- `src/actions/services/install-nginx.ts:127-183`
- `src/actions/services/set-static-ip.ts:145-201`
- `src/actions/services/configure-firewall.ts:163-249`

Consequently, the second iteration is unreachable after failure, `retryOnFailure` is never
read after destructuring, and `lastResult` is never assigned. The “failed after all
retries” results at `install-nginx.ts:217-236`, `set-static-ip.ts:230-249`, and
`configure-firewall.ts:277-296` are effectively dead failure paths.

The shared `bootstrap()` implementation shows the intended behavior: it assigns
`lastResult`, inspects success, and only breaks when retry is disabled or exhausted
(`bootstrap.ts:120-207`). Extract one `runAnsibleWithRetry` executor returning a typed
attempt/result summary. This is higher priority than stylistic consolidation because the
public schemas currently promise behavior production does not provide. No tests exercise
these three actions' retry fields.

### P1 — application manifests duplicate infrastructure selection policy

Manifest construction is centralized, which is good, but its VM defaults independently
reimplement decisions already made dynamically by `createVm`:

- `application-request.ts:169-179` hardcodes 2 cores, 4096 MiB, `20G`, `local-lvm`,
  node-specific `local`/`snippets`, `vmbr0`, and `ops`.
- `application-manifest.ts:56-75` also hardcodes the currently known node enum.
- `create-vm.ts:361-419` discovers and validates nodes; `:528-562` discovers/ranks
  datastores and bridges; `:633-665` derives the final cloud-init datastore and Terraform
  config.

Application lifecycle eventually calls `createVm`, so unavailable manifest defaults can
be adjusted later, but the manifest and confirmation preview can still promise choices
that the executor silently changes. Build manifests with requested intent plus unresolved
selection fields, or reuse one infrastructure-option resolver before the manifest is
confirmed.

### P1 — read/write client bases have drifted safety and error semantics

There is little useful cross-provider duplication: Proxmox token auth, OPNsense basic
auth, and Pi-hole session auth genuinely differ. The actionable duplication is within each
provider's read/write bases:

- OPNsense duplicates configuration and axios construction almost verbatim in
  `opnsense/readonly/base.ts:19-58` and `opnsense/writes/base.ts:48-87`, plus nearly the
  same sanitize/catch/`{error}` adapter at `readonly/base.ts:76-111` and
  `writes/base.ts:180-209`.
- Proxmox duplicates credential resolution, client creation, provenance wrapping, and
  catches in `proxmox/readonly/base.ts:19-137` and `proxmox/writes/base.ts:21-158`.
  They have already drifted: readonly sanitizes response-derived errors
  (`readonly/base.ts:123-135`), while write returns raw `error.message`
  (`writes/base.ts:145-151`).
- More seriously, OPNsense aborts when pre-write capture fails
  (`opnsense/writes/base.ts:93-128`), while Proxmox explicitly continues with a synthetic
  “capture_failed” snapshot (`proxmox/writes/base.ts:59-104`). That difference may be a
  policy choice, but it is undocumented and leaves the higher-risk write path without a
  real rollback/provenance state.

Share provider-specific client factories and one tool-boundary error adapter. Make
pre-write-capture failure policy explicit per operation/risk level rather than an
accidental consequence of which base class was copied.

### P1 — Pi-hole detects expired authentication but cannot recover

The Pi-hole interceptor recognizes 401/unauthorized and even logs that the session may
have expired (`pihole/client.ts:377-386`), but it only rejects (`:388-390`). The client
never clears `sessionCookie`, `csrfToken`, or `apiClient`; their only assignments are on
successful login (`:205-206`, `:234`, `:303`). `login()` therefore keeps returning the
expired cookie because both tokens remain populated. Every later call fails until process
restart.

Implement a single guarded re-authentication/replay on 401, using the existing
`loginPromise` to prevent a login stampede. The current client tests cover initial login
and record parsing but no session expiry (`tests/tools/pihole/client.test.ts:65-118`).

### P1 — ingestion has no shared complete-snapshot/reconcile contract

Network ingestion now has good, explicit completeness protection: it records per-source
degradation and only prunes from a complete non-empty snapshot
(`network-ingestion.ts:18-23`, `:44-86`, `:254-290`). That hardening landed in `0d27f38`
after false deletions.

The same policy is not reusable by other ingestors. Firewall exposure refresh obtains a
derived list, deletes every `EXPOSES`/`REACHABLE` relationship, and writes the replacement
(`firewall-ingestion.ts:130-147`). An empty result avoids deletion, but a non-empty partial
result is indistinguishable from a complete one and can replace the full relationship set.
Switch ingestion independently implements live-source validation and static fallback
(`switch-ingestion.ts:158-209`). Introduce a shared reconciliation result such as
`{records, complete, source, observedAt}` and make destructive prune/replace reject
`complete: false`.

### No manifest-validation duplication found

The application subsystem does not independently reimplement schema validation across its
compiler and executor: `ApplicationManifestSchema` is canonical
(`application-manifest.ts:94-168`), and lifecycle execution validates with it before
compilation (`application-lifecycle-action.ts:479-488`). The smell is duplicated
*selection policy*, described above, not duplicated Zod validation.

## 3. Traditional code smells

### P1 — the runner monolith was split, then regrew across the seam

The March review's original 3,550-line number should not be repeated as if still current.
The extraction did reduce `runner.ts` to 1,951 lines at `ce76650`. Since then:

| Revision | `runner.ts` | `handle-execute.ts` | Combined |
|---|---:|---:|---:|
| March extraction (`ce76650`) | 1,951 | 1,389 | 3,340 |
| Current | 2,275 | 2,158 | 4,433 |

The critical metric is function size: `runAgent()` is about 1,476 lines
(`runner.ts:800-2275`) and `handleExecute()` is about 1,944
(`handle-execute.ts:215-2158`). The extraction moved the execute monolith but did not
establish a size/responsibility boundary, and the combined hot path is now larger than the
old headline monolith. Continue extraction around tool-batch execution, response
synthesis, trace finalization, and deterministic chain handling; add a lightweight module
or function-size guard so this does not silently recur.

Other very long files (`server.ts` 2,720 lines, Proxmox readonly 2,267,
`twin-query-service.ts` 2,151, response formatter 1,447) align with the churn findings
above. They are worth splitting by route/operation family, but the runner/execute seam has
the clearest demonstrated regression.

The meaningful deep nesting is concentrated in the same hot paths rather than spread
uniformly across the repository: `handleExecute` nests the step loop, tool-batch branch,
parallel/sequential branches, per-tool policy/confirmation/error handling, and result
normalization (`handle-execute.ts:982-1858`). The copied service actions likewise nest a
retry loop, command loop, and catch that escapes both. These are responsibility problems,
not indentation preferences; extracting the batch/attempt result objects described above
would flatten them naturally.

### P1 — shell command assembly remains on live action paths

The earlier review's command-assembly finding is still live. Terraform concatenates a
command and `args.join(" ")` into `exec` (`terraform-runner.ts:735-750`). More directly,
`AnsibleRunner.runPlaybook()` interpolates playbook, inventory, `extraVars` values, and
`limit` into one shell command (`ansible-runner.ts:45-97`), and `bootstrap()` calls this
method (`bootstrap.ts:151`). `extraVars` is a user-facing arbitrary record in the action
schema, so quotes or shell metacharacters are not merely hypothetical path formatting.

The same runner already contains the safer design: `runPlaybookWithJsonVars()` writes
variables separately and invokes `execFile("ansible-playbook", args)`
(`ansible-runner.ts:145-176`). Route the public bootstrap path through that argv-based
method and convert Terraform execution to `execFile`/`spawn` with one argument per array
element. This is both injection hardening and correctness for values containing spaces.

### P1 — real-time deletes are logged, acknowledged, and lost

`queue-consumer.ts:137-142` handles a delete event by warning “not yet implemented,” then
calling `queue.complete(item.id)` and returning. This is worse than an ordinary TODO: it
turns an unperformed destructive synchronization operation into a successful queue item,
so stale chunks/entities persist and no retry occurs. Until delete semantics exist, mark
the item failed/dead-lettered rather than complete.

### P2 — error handling is principled at some boundaries, accidental at peers

The broad pattern itself is sensible: low-level API clients throw; tools translate failures
to `ExecutionResult.error`; top-level actions return domain results. The accidental cases
are peer implementations that violate their layer's convention:

- Proxmox readonly sanitizes caught errors while Proxmox write returns raw messages, as
  noted above.
- OPNsense pre-write capture throws while Proxmox capture logs and proceeds.
- Three service actions catch and return failure objects, but their inner throws bypass
  the advertised retry controller.
- `tool-executor` only learned to adapt thrown tools into `{error}` in `2d7b38f`, after a
  thrown tool bypassed reclassification and crashed the agent. This history argues for a
  single enforced tool-boundary adapter and tests for both thrown and returned failures.

### P2 — unused/dead repository surface

`src/agent/runner.ts.bak` is a 3,246-line stale source copy added in `79c1303`; Git already
retains the history it was intended to preserve. Remove it after confirming no external
workflow reads it.

A conservative repository-wide textual reference scan also found exported declarations
with no in-repository consumer, including `LocalEmbeddingService`
(`src/pce/vector/embeddings-local.ts:29`), `DEFAULT_ONTOLOGY`
(`src/pce/kg/schema/ontology.ts:202`), `generateToolsPrompt`
(`src/tools/tool-schema.ts:349`), and `sanitizeToolResult`
(`src/utils/sanitize.ts:77`). These may be intentional public surface, so they were not
deleted. Either cover/document them as supported API or make them private/remove them;
TypeScript's unused checks do not flag unused exports.

No material commented-out implementation blocks were found. The repository has explanatory
comments and a few intentional empty-catch fallbacks, but not a dormant second
implementation commented beside the live one.

### TODO/FIXME/HACK/XXX disposition

No genuine `FIXME`, `HACK`, or `XXX` marker was found. The two `"XXX"` strings in the
Proxmox tool are example placeholders, not debt markers. The TODOs are:

| Priority | Location | Disposition |
|---|---|---|
| P1 | `src/pce/realtime/queue-consumer.ts:139` | **Genuine and unsafe:** delete is unimplemented but acknowledged complete. |
| P1 | `src/tools/InfrastructureDiagnosticTool.ts:315-334` | **Genuine advertised stubs:** `vm_health`, `network_connectivity`, and `service_health` are in the public enum/examples (`:19-29`, `:87-101`) but always return “not implemented.” Either implement them or remove them from the offered schema. |
| P1 | `src/twin/api/twin-query-service.ts:2068-2076` | **Genuine data-fidelity gap:** returns `reachable: true` with `path: []` although a Neo4j path was retrieved. This remained from `REVIEW.md`. |
| P2 | `src/pce/realtime/queue.ts:27-35` | **Genuine durability limit:** the in-memory queue loses pending work on restart. Severity depends on whether webhooks are production-critical. |
| P2 | `src/pce/ingestion/proxmox-ingestion.ts:216-220` | **Genuine provenance gap:** `provenanceIds` are not extracted from ingested document metadata. |
| P2 | `src/pce/api/server.ts:1085-1098` | **Genuine placeholder:** cluster status always reports `alerts: []`; the same response silently caps VM/LXC resources at 50 without a truncation flag. |
| P3 | `src/tools/api-discovery/opnsense-discovery.ts:188-199` | **Genuine optional feature gap:** MCP discovery always returns an empty list; static/probe discovery still works. |
| P3 | `scripts/palindrome-services.service:9-14` | **Deployment-template instruction, not a hidden bug:** the unit is hardwired to user/path `tj`; parameterize it if the file is meant to be portable. |

No marker appeared stale/already completed. One nearby non-TODO comment is stale:
`switch-ingestion.ts:213-219` still says legacy Cisco interactive execution is a follow-up,
although `9b66ddb` implemented it. Correct the comment when that file is next touched.

### Magic values worth naming only where they affect correctness

Most numeric constants are ordinary operational defaults. Two deserve an explicit
contract:

- Cluster status truncates each resource list to 50 (`server.ts:1089-1095`) while still
  presenting full totals. Add `truncated`/`returnedCount` fields or pagination so a client
  cannot mistake the partial list for the complete inventory.
- The three broken retry loops duplicate a 5-second delay and attempt math. This belongs
  in the shared retry executor, not three local constants.

## 4. Test-quality smells

### P0 — “hybrid gold path” never checks the answer against its realistic fixture

`tests/flows/proxmox_hybrid_reasoning.test.ts` supplies a specific policy (reboot above
90% for five minutes), VM/node topology, and tool data, but the main assertion only checks
that response text is non-empty and that *some* Proxmox execution occurred
(`:175-200`). A second three-source test again accepts any non-empty response
(`:257-267`). The provenance test accepts text containing any of `vm`, `proxmox`, `error`,
or `unable` (`:312-330`).

All would pass if the agent recommended the opposite policy, named the wrong node, ignored
RAG entirely, or returned “unable to answer.” Replace these with deterministic captured
tool responses and assertions for the concrete VM ID, node, measured CPU, policy threshold,
and recommendation/evidence relationship.

### P0 — OPNsense end-to-end tests make the behavior under test optional

`tests/tools/opnsense/readonly/pce-integration.test.ts:20-63` is named “execute OPNsense
tool via PCE and return provenance tag,” but it returns from the test body when the server
is absent (a passing test, not Bun's skip), makes tool provenance conditional, and
explicitly accepts the tool not being triggered. The second test does not even require a
non-empty answer or tool source (`:66-104`). Any generic string can pass the first; almost
any response object can pass the second.

Use an explicit environment guard registered as `test.skip`, and when enabled require the
specific tool operation plus a provenance ID and at least one realistic rule/status field.

### P1 — confirmation replay test does not prove replay

`tests/agent/runner-confirmation-flow.test.ts:87-101` claims to verify that confirmation
replays pending executable input, but sets `pendingActionExecuteInput: "hi"` and only
asserts non-empty output plus absence of one error phrase. It would pass if confirmation
ignored the stored input and returned any unrelated response. Inject a runner/tool seam or
assert the resulting action/trace received the exact stored executable input.

### P1 — real Cisco fixture checks cardinality, one port, and one route

The synthetic parser tests are strong, but the realistic seed-file test only checks that a
switch exists, there are 48 port entities, Gi0/41 is correct, and one route exists
(`tests/parsers/cisco-ios-switch-parser.test.ts:112-131`). The other 47 port records could
have duplicated IDs, blank names, wrong access VLANs, or lost descriptions and the test
would still pass as long as the count remained 48. Add a compact golden projection keyed
by port name (or at least assert uniqueness and the known VLAN/description distribution)
for the sanitized real configuration.

### P1 — Proxmox write tests often prove dispatch, not request fidelity

Representative start/stop/migrate tests assert `result.data` and the echoed action, and in
some cases merely that `post` was called (`tests/tools/proxmox/writes/proxmox-write-tool.test.ts:72-121`,
`:123-151`). They do not assert the endpoint path, target node, VM ID, migration target,
body, or provenance contents. A regression that posts `start_vm` to the wrong VM or omits
`targetNode` can still pass. Assert exact mock calls and returned identity/provenance for
each destructive/write operation; reserve structural assertions for schema smoke tests.

### P3 — import-smoke tests add pass count but no behavioral confidence

`tests/pce/setup.test.ts:8-50` only checks that exports are defined. That is acceptable as
a small packaging smoke test, but it should not be counted as evidence that DLM,
redaction, vector, RAG, or ingestion behavior works. Keep it labeled as import-surface
coverage and rely on fidelity tests for quality claims.

## Recommended order

1. Fix and test the three false retry contracts; extract the shared executor.
2. Stop acknowledging unperformed delete events; add deletion fidelity tests.
3. Add Pi-hole 401 re-authentication and a deterministic expired-session test.
4. Put a typed complete-snapshot contract in front of all destructive ingestion reconcile
   operations.
5. Split `handleExecute` by tool-batch, progress/budget, synthesis, and trace-finalization
   responsibilities; prevent size regrowth.
6. Replace output prose recognition with structured result rendering, then add realistic
   golden/fidelity tests at the agent and dashboard boundaries.
7. Split SSH transports behind explicit strategies and test connection/process lifecycle.
