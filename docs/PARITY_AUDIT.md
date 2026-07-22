# Feature-Family Parity Audit

**Date:** 2026-07-22  
**Status:** Diagnostic architecture review  
**Scope:** Comparable tool, action, ingestion, rendering, and test families  
**Explicit exclusion:** Intent classification, domain taxonomy, and routing completeness

## Executive Summary

This audit compares each feature family against its most mature sibling rather than evaluating modules in isolation. “Most mature” means the member with the strongest combination of production age, implementation depth, behavior tests, documentation, error handling, and surrounding-system integration. A younger implementation is not presumed deficient; it is compared against the concrete contracts already demonstrated elsewhere in the repository.

The classification work documented in `src/reasoning/CLASSIFICATION_STANDARDS.md` is complete and out of scope. Its method—not its subject—is reused here: enumerate the family, identify the strongest existing contract, and cite every deviation.

Five findings deserve priority:

1. **The per-action security model is not the production action path.** Ten atomic action tools encode action-specific ACLs, risk, schemas, and examples, but the loader registers only the generic `ActionTool` plus `ApplicationLifecycleTool` (`src/agent/tool-loader.ts:18`, `src/agent/tool-loader.ts:37-38`). Production authorization evaluates the registered outer tool (`src/agent/tool-policy.ts:8-20`, `src/agent/handlers/handle-execute.ts:1335-1343`), so the generic tool's `admin`/`ops` ACL applies even to atomic tools designed as `admin`-only.
2. **A failed action can be surfaced as a successful tool execution.** Action implementations return `{ success: false, message }`, while both the generic and most atomic adapters emit a success event and return data unless an exception was thrown (`src/tools/ActionTool.ts:314-330`, `src/tools/actions/CreateVmTool.ts:68-75`). The agent runner determines success from the absence of `result.error` (`src/agent/handlers/handle-execute.ts:1517-1547`). `ApplicationLifecycleTool` already demonstrates the correct adapter contract by converting `!result.success` into `ExecutionResult.error` (`src/tools/actions/ApplicationLifecycleTool.ts:70-81`).
3. **Global stale cleanup is not gated by source health.** Network ingestion carefully marks partial collection and skips local pruning for failed sources (`src/pce/ingestion/network-ingestion.ts:15-24`, `src/pce/ingestion/network-ingestion.ts:44-68`), but the scheduler records that degraded run as successful and later invokes global cleanup unconditionally (`src/pce/scheduler/ingestion-scheduler.ts:234-261`, `src/pce/scheduler/ingestion-scheduler.ts:337-363`). That cleaner includes network interfaces and firewall rules (`src/twin/cleanup/stale-node-cleaner.ts:692-723`), recreating the deletion risk the network orchestrator explicitly avoids.
4. **Rendering quality is fixture-driven only for Pi-hole, while older special cases bypass the safe generic renderer.** The generic renderer escapes table headers and cells (`dashboard/js/response-renderer.js:378-396`, `dashboard/js/response-renderer.js:427-445`), but the Proxmox-specific trace formatter interpolates tool values directly and its parse-failure path injects the raw preview into HTML (`dashboard/js/reasoning.js:25-106`, `dashboard/js/reasoning.js:121-123`). Pi-hole has a result-shape corpus covering both trace JSON and terse assistant output (`tests/dashboard/response-renderer.pihole.test.ts:7-14`, `tests/dashboard/response-renderer.pihole.test.ts:19-170`); Proxmox and OPNsense do not have equivalent trace-format tests.
5. **Readonly and write families have contract drift hidden by aggregate test counts.** Proxmox and OPNsense notes still claim internal IPs are sanitized (`src/tools/proxmox/readonly/proxmox-readonly-tool.ts:175-182`, `src/tools/opnsense/readonly/opnsense-readonly-tool.ts:109-116`), while the canonical sanitizer intentionally preserves IPs and MACs (`src/agent/tool-sanitizer.ts:8-15`). The current sanitizer tests confirm that policy (`tests/agent/tool-sanitizer.test.ts:11-20`), but the older Proxmox redaction suite asserts the opposite (`tests/tools/proxmox/readonly/redaction.test.ts:223-268`). A targeted run fails on this stale contract.

These are not five unrelated omissions. They share a root cause: family membership is implicit, and production completeness is not enforced. Classification now has an explicit taxonomy, tool-owned registry, and completeness checks. The remaining systems need equivalent, domain-appropriate contracts.

## Evidence and Method

### Snapshot

The audit was performed against the working tree on 2026-07-22. Existing unrelated changes in `.pce-dod-test/snapshots.json` and `.pce-ib-dod-test/snapshots.json` were not modified.

Evidence came from:

- implementation and schema inspection with current file/line references;
- test enumeration plus inspection of what each test actually executes;
- `git log --follow` and `git blame` for age and production-registration history;
- targeted Bun test runs; and
- comparison of tool outputs with dashboard and twin-graph consumers.

Test counts are used only as a discovery signal. A schema-enum assertion is not counted as behavioral coverage for every enumerated action, and a test that manually constructs an otherwise unregistered tool does not prove production integration.

### Family reference selection

| Family | Reference member | Evidence for reference status |
|---|---|---|
| Readonly tool modules | Proxmox readonly | Oldest cohort (first commit `239e009`, 2025-11-17), 2,267 implementation lines, 24 commits, seven readonly test files, graph/vector/twin ingestion |
| Write tool modules | Proxmox write | 1,540 implementation lines, 17 commits, ten operations, deeper operation coverage, pre/post state capture |
| Atomic action implementations | `CreateVmTool` / `create-vm` | Oldest and deepest action implementation: 982 lines, 17 commits, dedicated behavior and failure suites, plan-first workflow |
| Multi-step action orchestration | Application lifecycle | Explicit journal, dependency ordering, reverse compensation, idempotency tests, and correct failure adaptation |
| Ingestion failure semantics | Network ingestion | Snapshot-aware reconciliation, explicit degraded state, per-source prune guards, and direct partial-failure tests |
| Tool-result rendering | Pi-hole result-shape fixtures plus the generic adaptive renderer | Every Pi-hole readonly shape is exercised in both trace and assistant formats; generic renderer provides escaping and structured tables/facts |

The reference is a baseline, not a declaration that it is defect-free. Several findings are cases where a newer sibling improved one dimension and exposed debt in the older reference.

## Family 1: Readonly Tools

### Reference: Proxmox readonly

Proxmox readonly is the overall family reference because it has the longest production history and deepest surrounding-system integration:

- 22 schema actions are declared at `src/tools/proxmox/readonly/proxmox-readonly-tool.ts:17-62`.
- Tool metadata, examples, and operator notes occupy `src/tools/proxmox/readonly/proxmox-readonly-tool.ts:84-182`.
- Its base execution path adds source, collection time, tool call ID, and duration provenance (`src/tools/proxmox/readonly/base.ts:98-114`).
- Proxmox ingestion feeds vector, legacy graph, and twin stores (`src/pce/ingestion/proxmox-ingestion.ts:742-829`).
- The readonly subtree contains seven test files and 130 tests, including client, normalization, graph/vector, behavior, and redaction concerns.

Pi-hole is nevertheless the better local reference for schema notes and action-to-rendering completeness. Its nine examples cover all eight actions, with separate domain/client query-log variants (`src/tools/pihole/readonly/pihole-readonly-tool.ts:70-109`), and its notes describe aggregation semantics, unavailable totals, blocklist limitations, and the live-memory window (`src/tools/pihole/readonly/pihole-readonly-tool.ts:110-122`).

### Parity matrix

| Dimension | Proxmox | OPNsense | Pi-hole |
|---|---:|---:|---:|
| Implementation size | 2,267 lines | 810 lines | 175 lines |
| First implementation commit | 2025-11-17 | 2025-11-17 | 2026-07-22 |
| Schema actions | 22 | 20 | 8 |
| Concrete examples | 14 | 4 | 9, covering every action |
| Readonly behavior tests | broad, but not every action | concentrated on a minority of actions | every action dispatched |
| Base provenance | source, time, call ID, duration | none | none |
| Persistent knowledge integration | vector + graph + twin | network/firewall graph + twin paths | explicitly live-only |
| Dedicated rendering corpus | no | no | yes, 19 tests |

### Gaps relative to the reference contract

#### R1. OPNsense's schema surface is much broader than its behavioral examples and tests

OPNsense declares 20 actions (`src/tools/opnsense/readonly/opnsense-readonly-tool.ts:12-49`), but supplies examples only for four firewall operations (`src/tools/opnsense/readonly/opnsense-readonly-tool.ts:91-108`). Its main test file verifies that action names are present in the enum (`tests/tools/opnsense/readonly/opnsense-readonly.test.ts:21-75`), then exercises a narrower set of system status, interface status, list, and alias behavior. There are no direct action-behavior assertions for several structurally distinct paths, including firewall categories/states, VLANs and virtual IPs, system backups, routes, interface statistics/logs, and DHCP operations.

This is materially different from Pi-hole, where all eight dispatch branches are exercised (`tests/tools/pihole/readonly/pihole-readonly.test.ts:69-181`). Enum inclusion proves schema availability, not that the branch invokes the right client method or normalizes its response correctly.

**Recommendation:** require one dispatch/normalization test and one representative example for every readonly action. Generate a completeness assertion from the schema enum so new actions cannot silently stop at registration.

#### R2. Proxmox's large suite still leaves action-level holes

The Proxmox behavior suite is deep (`tests/tools/proxmox/readonly/proxmox-readonly-tool.test.ts:102-700`), but it does not directly exercise every action declared at `src/tools/proxmox/readonly/proxmox-readonly-tool.ts:17-62`. In particular, the suite has no action invocation for `node_storage`, `node_services`, `node_temperature`, `get_vm_guest_network`, or `get_version`.

The aggregate count of 130 tests obscures this because many tests cover clients, redaction, and ingestion rather than the public dispatch matrix.

**Recommendation:** add an action-manifest test that compares declared actions with tested fixtures. Preserve the specialized client and ingestion suites, but do not use their count as a proxy for dispatcher completeness.

#### R3. Provenance is inconsistent across equivalent live-read tools

Proxmox returns `_provenance` with source, collection timestamp, call ID, and duration (`src/tools/proxmox/readonly/base.ts:98-114`). OPNsense and Pi-hole sanitize and return data but do not attach equivalent provenance (`src/tools/opnsense/readonly/base.ts:76-111`, `src/tools/pihole/readonly/base.ts:46-67`).

This is not merely cosmetic: live data can appear beside twin-derived data in reasoning and dashboard flows. Without a common timestamp/source contract, consumers cannot consistently disclose freshness.

**Recommendation:** move readonly provenance construction into a shared base/helper and adopt it in all three modules. If a tool intentionally omits provenance, require an explicit reason in its metadata rather than inheriting silence.

#### R4. Sanitization notes and tests contradict the canonical sanitizer

Proxmox notes say internal IP addresses, MAC addresses, and credentials are automatically sanitized (`src/tools/proxmox/readonly/proxmox-readonly-tool.ts:175-182`). OPNsense makes the same claim for internal IPs and credentials (`src/tools/opnsense/readonly/opnsense-readonly-tool.ts:109-116`). The canonical sanitizer now explicitly preserves IP addresses and MAC addresses because they are operational data (`src/agent/tool-sanitizer.ts:8-15`), and its tests confirm preservation (`tests/agent/tool-sanitizer.test.ts:11-20`). OPNsense's own readonly tests likewise preserve RFC1918 addresses (`tests/tools/opnsense/readonly/opnsense-readonly.test.ts:266-350`).

The older Proxmox redaction suite still asserts that user IDs, IPs, and MACs are removed (`tests/tools/proxmox/readonly/redaction.test.ts:223-268`, `tests/tools/proxmox/readonly/redaction.test.ts:289-335`). In the targeted audit run, that suite failed immediately when `root@pam` was preserved at `tests/tools/proxmox/readonly/redaction.test.ts:14`.

**Recommendation:** make `tool-sanitizer.ts` the named source of truth; update tool notes to distinguish credentials/tokens from intentionally preserved infrastructure identifiers; replace stale Proxmox redaction expectations with canonical-policy assertions.

#### R5. Error sanitization is paired with unsanitized diagnostic logging

All three bases sanitize the returned error, but OPNsense logs the original error message, response data, and stack (`src/tools/opnsense/readonly/base.ts:89-99`), and Pi-hole logs the original message and stack (`src/tools/pihole/readonly/base.ts:53-58`). Proxmox similarly logs the raw error before returning a sanitized error (`src/tools/proxmox/readonly/base.ts:115-121`).

The user-facing contract therefore differs from the operational log contract, without an explicit policy explaining whether secrets in upstream response bodies are acceptable in logs.

**Recommendation:** introduce a shared safe-error logger that sanitizes message and response payload before structured logging while retaining non-sensitive status codes and endpoint context.

#### R6. Persistent-knowledge participation is asymmetric but Pi-hole's asymmetry is documented

Proxmox and OPNsense feed persistent graph/twin paths. Pi-hole is live-only. Unlike most parity gaps, this one is an explicit design choice: the domain consumer registry says DNS dispatches live to `pihole_readonly` and has no twin chain (`src/reasoning/domain-consumers.ts:77-78`).

No change is required solely for parity. If DNS history or correlation becomes a product requirement, it should be introduced as a new ingestion decision, not inferred from the existence of the live tool.

## Family 2: Write Tools

### Reference: Proxmox write

Proxmox write is the breadth and maturity reference: ten actions, 1,540 implementation lines, 17 commits, and 22 tests. It captures pre-state, performs the operation, captures post-state, and returns a change summary (`src/tools/proxmox/writes/base.ts:55-104`, `src/tools/proxmox/writes/base.ts:150-166`). Its schema and operational notes are at `src/tools/proxmox/writes/proxmox-write-tool.ts:63-196`.

OPNsense safewrite is stronger in one narrow dimension: its base computes a recursive change list rather than only returning current/proposed snapshots (`src/tools/opnsense/writes/base.ts:131-175`). Its tool-level `requiresConfirmation: true` also matches its blanket confirmation note (`src/tools/opnsense/writes/opnsense-safewrite-tool.ts:44-61`, `src/tools/opnsense/writes/opnsense-safewrite-tool.ts:97-102`).

### Gaps relative to the reference contract

#### W1. Proxmox's confirmation documentation contradicts production metadata

The Proxmox description and notes state that all write operations require human confirmation (`src/tools/proxmox/writes/proxmox-write-tool.ts:63-71`, `src/tools/proxmox/writes/proxmox-write-tool.ts:189-196`), but metadata sets `requiresConfirmation: false` (`src/tools/proxmox/writes/proxmox-write-tool.ts:124-133`).

Production derives additional risk from the nested action name (`src/agent/tool-risk.ts:23-36`) and requests confirmation for sufficiently risky calls (`src/agent/handlers/handle-execute.ts:1359-1368`). That means destructive/create operations receive confirmation, while lower-risk start/stop-style operations can proceed under the outer metadata. The implementation may be reasonable; the statement “all operations require confirmation” is not.

**Recommendation:** declare confirmation per action in a single action manifest and generate both schema notes and runtime policy from it. Do not retain a blanket note that the runtime does not honor.

#### W2. Both modules claim rollback capability beyond what their bases implement

Proxmox notes promise pre-write state capture “for rollback capability” (`src/tools/proxmox/writes/proxmox-write-tool.ts:189-196`), and OPNsense says the same (`src/tools/opnsense/writes/opnsense-safewrite-tool.ts:97-102`). Both bases capture state for comparison, but neither provides a generic persisted, replayable compensation operation. Proxmox's snapshot rollback action is guest-snapshot-specific; it is not rollback for arbitrary start, migrate, configuration, or deletion operations.

The capture semantics also diverge. Proxmox continues after a failed pre-state capture and returns a marker (`src/tools/proxmox/writes/base.ts:55-104`), while OPNsense fails the operation when state capture fails (`src/tools/opnsense/writes/base.ts:89-129`). Neither policy is stated in the tool notes.

**Recommendation:** reserve “rollback” for a tested compensation path. Describe the current feature as “pre/post audit state” until snapshots are durably stored and an operation-specific restore path exists. Document whether inability to capture pre-state blocks mutation.

#### W3. Public action coverage is incomplete in both suites

Proxmox declares ten actions (`src/tools/proxmox/writes/proxmox-write-tool.ts:77-88`) but its examples cover only start, reboot, stop, migrate, and create snapshot (`src/tools/proxmox/writes/proxmox-write-tool.ts:136-188`). Its behavior tests do not execute `destroy_vm`.

OPNsense declares five actions (`src/tools/opnsense/writes/opnsense-safewrite-tool.ts:12-40`), but examples cover only the first three (`src/tools/opnsense/writes/opnsense-safewrite-tool.ts:64-96`). The tests mention `toggle_rule_enabled` and `update_alias_description` only through the enum; they do not execute those branches. Existing dry-run and success tests concentrate on alias creation and rule enablement (`tests/tools/opnsense/writes/opnsense-safewrite.test.ts:85-158`).

**Recommendation:** enforce action-to-example and action-to-behavior-test completeness. Destructive actions need explicit assertions for confirmation, validation failure, upstream failure, audit output, and unchanged state on dry run.

#### W4. Diff quality is not a shared contract

Proxmox returns current/proposed state summaries (`src/tools/proxmox/writes/base.ts:150-166`); OPNsense computes path-level recursive changes (`src/tools/opnsense/writes/base.ts:131-175`). As a result, confirmation UX and audit evidence depend on which sibling executes the write.

**Recommendation:** define a common write-preview envelope: target, normalized pre-state, proposed change set, irreversible fields, expected side effects, and capture confidence. Providers may add domain-specific detail, but dashboard and confirmation consumers should receive the same minimum shape.

## Family 3: Action Tools and Multi-Step Mutations

This family has two relevant references because it contains two different contracts:

- `CreateVmTool` and `create-vm` are the reference for an individual atomic action: strict input schema, high/admin metadata, dry-run planning, validation, and extensive behavior tests (`src/tools/actions/CreateVmTool.ts:10-54`).
- Application lifecycle is the reference for multi-step execution: journaled steps, dependency ordering, reverse compensation, and correct failure propagation (`src/actions/applications/lifecycle-executor.ts:210-388`, `src/tools/actions/ApplicationLifecycleTool.ts:70-81`).

### Gaps relative to those contracts

#### A1. The atomic action registry is not loaded in production

The action tooling journal states that ten atomic tools replace the generic action surface, with per-action ACL/risk and loader registration as the goal (`src/tools/golden-baking-journal.md:20-69`). The classes exist and tests instantiate them, but the production loader imports only `ApplicationLifecycleTool` from `src/tools/actions` and still instantiates the generic `ActionTool` (`src/agent/tool-loader.ts:18`, `src/agent/tool-loader.ts:37-38`).

The atomic test suite manually constructs the wrappers (`tests/tools/actions/action-tools.test.ts:13-24`) and validates their schemas/metadata (`tests/tools/actions/action-tools.test.ts:26-108`). It never asserts that `loadTools()` contains them or excludes the generic replacement. Git blame shows the wrappers were created but never wired into this loader; this is not a recent removal.

**Impact:** the strongest policy and schema implementation is dead with respect to the production registry.

**Recommendation:** choose and enforce one architecture:

1. register all atomic tools and remove/deprecate the generic mutation entry point; or
2. retain one generic tool but move the atomic schemas, ACLs, risk, confirmation, examples, and adapters into a canonical action-definition registry consumed by it.

Add a production-registry completeness test analogous to classification completeness: every executable action definition must have exactly one registered production surface.

#### A2. The generic tool broadens ACLs for high-risk actions

The generic `ActionTool` allows both `admin` and `ops`, reports medium risk, and sets `requiresConfirmation: false` (`src/tools/ActionTool.ts:36-51`). Atomic compute, firewall, VLAN, and static-IP tools declare high risk and `admin`-only; for example, `CreateVmTool` does so at `src/tools/actions/CreateVmTool.ts:10-25`, and `DestroyVmTool` at `src/tools/actions/DestroyVmTool.ts:10-22`.

Production authorization checks the registered tool metadata before execution (`src/agent/tool-policy.ts:8-20`, `src/agent/handlers/handle-execute.ts:1335-1343`). Nested action risk derivation helps confirmation (`src/agent/tool-risk.ts:23-36`), but it does not repair the outer tool ACL. An `ops` caller can therefore reach generic actions whose atomic policy says `admin`-only.

**Recommendation:** treat this as a policy bug, not documentation debt. Authorization must resolve the same per-action definition used for validation and risk before any action executes.

#### A3. Action-level failure is not consistently mapped to tool failure

The generic action adapter emits “completed successfully” and returns the action result as data after any non-throwing call (`src/tools/ActionTool.ts:314-330`). Atomic wrappers follow the same pattern; `CreateVmTool` is representative (`src/tools/actions/CreateVmTool.ts:68-75`). Many underlying actions communicate failure as `{ success: false, message }`, so no exception is required.

The execution handler considers the tool successful when `result.error` is absent (`src/agent/handlers/handle-execute.ts:1517-1547`). This can produce a success event, success metrics, and no recovery flow around a failed action.

Application lifecycle already demonstrates the required adapter: `!result.success` becomes `ExecutionResult.error` (`src/tools/actions/ApplicationLifecycleTool.ts:70-81`).

**Recommendation:** centralize an action-result adapter and forbid wrappers from returning `success: false` inside successful data. Add contract tests for every action adapter: returned failure, thrown failure, timeout, and partial completion must all produce `ExecutionResult.error` with preserved safe diagnostics.

#### A4. Newer multi-step actions lack compensation demonstrated by application lifecycle

Application lifecycle records completed steps and compensates them in reverse order (`src/actions/applications/lifecycle-executor.ts:318-388`). Several other multi-step actions mutate sequentially without an equivalent recovery contract:

- `install-nginx` installs packages and starts/enables the service in separate commands (`src/actions/services/install-nginx.ts:135-184`); an intermediate failure leaves earlier changes.
- `configure-firewall` installs UFW, changes default policy, adds rules, and enables the firewall (`src/actions/services/configure-firewall.ts:171-250`) without restoring the prior ruleset on later failure.
- `set-static-ip` writes a fixed netplan path and applies it (`src/actions/services/set-static-ip.ts:153-202`) without backing up/restoring the prior configuration or verifying post-change connectivity.
- `sync-dhcp-to-dns` deletes an existing DNS record before creating the replacement (`src/actions/network/sync-dhcp-to-dns.ts:195-229`); if creation fails, the old record is not restored (`src/actions/network/sync-dhcp-to-dns.ts:232-258`).

**Recommendation:** adopt the lifecycle journal/compensation protocol for multi-step mutations. At minimum, each action definition must declare whether it is transactional, compensatable, idempotent-only, or explicitly irreversible, and confirmation output must surface that status.

#### A5. Behavior coverage follows implementation age rather than mutation risk

Create/destroy VM have multiple dedicated behavior and failure suites. `sync-dhcp-to-dns`, `install-nginx`, and `set-static-ip` have no equivalent direct action suite; firewall coverage focuses on source validation rather than executing and failing each mutation step. The atomic wrapper schema tests do not exercise these action implementations (`tests/tools/actions/action-tools.test.ts:26-108`).

**Recommendation:** prioritize tests by blast radius, not file age. For each multi-step action, inject failure after every irreversible step and assert compensation or an explicit partial-state result.

## Family 4: Ingestion Pipelines

### Reference: network ingestion's snapshot-aware failure handling

Network ingestion is the correctness reference because it has an explicit degraded-state contract and source-scoped reconciliation:

- it tracks partial node and OPNsense collection failure (`src/pce/ingestion/network-ingestion.ts:15-24`);
- it skips local pruning for a node whose interfaces could not be read (`src/pce/ingestion/network-ingestion.ts:44-68`);
- it marks OPNsense failure rather than interpreting it as an empty inventory (`src/pce/ingestion/network-ingestion.ts:71-92`); and
- it prunes only against successful snapshots (`src/pce/ingestion/network-ingestion.ts:254-290`).

The direct tests assert the essential distinction: a failed node is not pruned while healthy node data is reconciled (`tests/pce/ingestion/network-ingestion.test.ts:51-116`).

Proxmox remains the breadth reference because it writes vector, legacy graph, and twin stores (`src/pce/ingestion/proxmox-ingestion.ts:742-829`), but it does not expose network ingestion's failure semantics.

### Pipeline parity matrix

| Pipeline | Failure/degraded result | Source-scoped stale cleanup | Provenance | Direct orchestrator tests |
|---|---|---|---|---|
| Proxmox | optional-store failures are logged and suppressed | global age cleanup; no source health result | source/time in entities and live tool | present, but much coverage constructs expected objects |
| Network | explicit `networkDegraded` | local snapshot-aware pruning | source + collected time | two direct partial-failure tests |
| Firewall | fetch error returns normally | global cleanup for rules; aliases never pruned | parser source metadata | none |
| Switches | errors return zero counts | no stale pruning for switch/port | strong declared-vs-observed provenance | none |
| Topology | exceptions fail run | no removal reconciliation | source path + version hash | none |

### Gaps relative to the reference contract

#### I1. Scheduler success semantics discard network's degraded state

The scheduler sets `networkSuccess = true` whenever the network orchestrator resolves, including when `networkDegraded` is true (`src/pce/scheduler/ingestion-scheduler.ts:234-261`). It then records a success metric and later runs global stale cleanup (`src/pce/scheduler/ingestion-scheduler.ts:337-363`). Overall success likewise does not incorporate degraded collection (`src/pce/scheduler/ingestion-scheduler.ts:365-372`).

The global cleaner ages out `network_interface` and `firewall_rule` entities (`src/twin/cleanup/stale-node-cleaner.ts:692-723`). A source can therefore be protected from local snapshot pruning in the orchestrator but still lose data after enough degraded scheduler cycles.

**Recommendation:** use a typed ingestion result—`healthy`, `degraded`, or `failed`—with per-source coverage. Pass that coverage into cleanup, and permit deletion only for entity scopes whose authoritative source completed successfully in the current reconciliation window.

#### I2. Firewall fetch failure is indistinguishable from successful no-op ingestion

Firewall ingestion logs and returns when the tool result has an error (`src/pce/ingestion/firewall-ingestion.ts:31-45`) and also returns when no rules are parsed (`src/pce/ingestion/firewall-ingestion.ts:62-65`). Because the method resolves, the scheduler records success (`src/pce/scheduler/ingestion-scheduler.ts:263-283`) and global cleanup remains eligible to delete stale firewall rules.

Aliases have the opposite lifecycle: the stale cleaner explicitly never deletes them (`src/twin/cleanup/stale-node-cleaner.ts:493-508`). The current system can therefore delete rules after collection failure while retaining aliases indefinitely after authoritative removal.

**Recommendation:** make failure, authoritative empty, and partial result distinct return values. Define snapshot reconciliation for both rules and aliases, with source-health gating.

#### I3. Firewall relationship refresh does not reconcile an authoritative empty set

The firewall orchestrator returns before deleting old derived relationships when the newly derived relationship set is empty (`src/pce/ingestion/firewall-ingestion.ts:130-147`). If current policy legitimately produces zero `EXPOSES`/`REACHABLE` relationships, stale relationships remain because deletion occurs only after the non-empty guard.

**Recommendation:** on a healthy authoritative snapshot, delete prior derived relationships first and then upsert zero or more current relationships. On failed/degraded collection, perform neither operation.

#### I4. Switch ingestion has excellent provenance but no removal lifecycle

Switch ingestion explicitly distinguishes declared inventory from observed state (`src/pce/ingestion/switch-ingestion.ts:1-24`) and tags resulting entities accordingly (`src/pce/ingestion/switch-ingestion.ts:109-188`). Collection errors, however, return without a failed/degraded result, and an all-failed run can return zero counts (`src/pce/ingestion/switch-ingestion.ts:73-95`). The scheduler treats any resolved run as success (`src/pce/scheduler/ingestion-scheduler.ts:286-305`).

The global cleaner excludes switches and switch ports from deletion (`src/twin/cleanup/stale-node-cleaner.ts:704-710`), so removed declarations and ports persist indefinitely.

**Recommendation:** preserve the declared/observed provenance model, but add source snapshots and reconciliation rules: removal from declared inventory should remove or retire the declaration; a healthy observed poll should reconcile observed ports; an unavailable device should retain its last known observed state with stale status.

#### I5. Topology ingestion upserts versioned source data but never reconciles removals

Topology entities carry source path and version hash (`src/pce/ingestion/topology-ingestion.ts:102-140`), but the orchestrator only writes nodes and relationships (`src/pce/ingestion/topology-ingestion.ts:434-456`). Removing an entity or relationship from the YAML source does not remove its prior graph representation.

**Recommendation:** treat each topology file/version as an authoritative snapshot for the identities it owns. Reconcile entities and relationships absent from the new version, with an explicit retain/tombstone policy for nodes also owned by live discovery.

#### I6. Proxmox reports a healthy run after partial destination failure

Proxmox catches twin ingestion failure and continues (`src/pce/ingestion/proxmox-ingestion.ts:765-775`). It also catches failures for optional graph sources and continues (`src/pce/ingestion/proxmox-ingestion.ts:796-801`), then returns counts without a degraded/destination-health field (`src/pce/ingestion/proxmox-ingestion.ts:813-826`). The scheduler launches the script as a subprocess and sees only its exit status (`src/pce/scheduler/ingestion-scheduler.ts:203-232`).

**Recommendation:** emit a structured run manifest with source health, destination health, counts, and reconciliation eligibility. The CLI should exit nonzero for required-destination failure and use a distinct degraded status or machine-readable report for optional-destination failure.

#### I7. Ingestion orchestration lacks contract-level scheduler tests

There are no direct orchestrator tests for firewall, switches, or topology, and no scheduler tests covering degraded runs plus cleanup. Proxmox has a larger ingestion suite, but portions construct expected nodes/relationships or inspect source strings rather than invoking the orchestrator (`tests/pce/proxmox-ingestion.test.ts:107-240`). Network's two direct tests are the only current proof of source-scoped partial-failure behavior (`tests/pce/ingestion/network-ingestion.test.ts:51-116`).

**Recommendation:** build a common ingestion contract suite parameterized by pipeline. It must cover healthy non-empty, healthy empty, partial source failure, total source failure, destination failure, removed entity, and cleanup eligibility. Add a scheduler integration test proving degraded sources cannot trigger their stale deletion.

#### I8. CLI cleanup conventions are inconsistent and can be bypassed by immediate exit

Network, firewall, and switch scripts express disposal in `finally` blocks (`scripts/ingest-network.ts:5-18`, `scripts/ingest-firewall.ts:5-15`, `scripts/ingest-switches.ts:5-18`). Their catch blocks nevertheless call `process.exit(1)` before control reaches the end of the try/catch/finally construct. Proxmox and topology are less defensive: each closes its graph connection only on the happy path, then calls `process.exit(1)` from the catch (`scripts/ingest-proxmox.ts:136-147`, `scripts/ingest-topology.ts:18-43`).

All five scripts can therefore report the same high-level “ingestion failed” outcome with different cleanup guarantees. Proxmox additionally logs the full stack while the smaller scripts log only the message, so operational diagnostics are not normalized either.

**Recommendation:** never call immediate exit from an ingestion catch. Set `process.exitCode`, close/dispose all initialized resources in `finally`, and emit the same structured run manifest used by the scheduler. Add a subprocess test that injects failure after connection and verifies disposal plus exit status.

#### I9. Scheduling prevents overlap but has no per-pipeline timeout contract

The scheduler starts an immediate run and invokes subsequent runs from `setInterval` without awaiting them (`src/pce/scheduler/ingestion-scheduler.ts:86-106`). An `isRunning` guard correctly skips overlapping cycles (`src/pce/scheduler/ingestion-scheduler.ts:158-166`), but the five jobs are then awaited sequentially (`src/pce/scheduler/ingestion-scheduler.ts:203-332`) with no visible per-job deadline. One hung provider or subprocess can hold `isRunning` indefinitely and cause every later interval to be skipped.

**Recommendation:** define per-pipeline deadlines, abort/disposal behavior, and a whole-run deadline. A timeout must produce `failed` or `degraded` source health—not a synthetic empty snapshot—and must be covered by scheduler tests.

## Family 5: Tool-Result Rendering

### Reference: Pi-hole fixtures and the adaptive renderer

Pi-hole is the rendering parity reference even though it is the newest tool family. Its fixture suite explicitly covers trace JSON and terse assistant data (`tests/dashboard/response-renderer.pihole.test.ts:7-14`), exercises all readonly result shapes (`tests/dashboard/response-renderer.pihole.test.ts:19-170`), and checks real/synthetic text variants and data-loss cases (`tests/dashboard/response-renderer.pihole.test.ts:172-329`).

The generic renderer is the implementation reference. It recognizes arrays and records, renders homogeneous multi-row data as tables, and escapes structured values (`dashboard/js/response-renderer.js:378-445`). Structured assistant output is preferred before fallback rendering (`dashboard/js/response-renderer.js:512-525`).

### Gaps relative to the reference contract

#### D1. Proxmox-specific trace rendering bypasses generic escaping

`formatToolResult()` special-cases only Proxmox VMs, containers, and nodes plus graph entities (`dashboard/js/reasoning.js:25-106`). Those branches interpolate names, IDs, node names, status, and entity fields directly into HTML. The generic renderer escapes headers/cells, but these older branches do not call it.

The parse-failure path also places `dataPreview` directly inside `<pre>` (`dashboard/js/reasoning.js:121-123`). A tool value containing markup can therefore reach the DOM without the escaping provided by the newer generic renderer.

**Recommendation:** remove the bespoke branches where the adaptive renderer produces equivalent output, or route every value through one shared escaping primitive. Escape parse-failure previews before insertion. Treat this as a dashboard safety defect, not merely a style mismatch.

#### D2. Older tool families lack result-shape fixture matrices

There is no test importing or directly exercising `formatToolResult()` in `dashboard/js/reasoning.js`. Proxmox and OPNsense data appears in some generic/fuzz corpora, but those tests exercise raw-text fallback rather than the trace formatter and every public action shape.

As a result:

- only three of 22 Proxmox readonly shapes have bespoke trace rendering;
- none of the 20 OPNsense readonly shapes has a family-specific rendering contract; and
- changes to the unescaped special cases or raw-preview fallback have no direct regression test.

Valid JSON generally falls through to the adaptive renderer (`dashboard/js/reasoning.js:117-120`), so the current problem is not a blanket raw-JSON fallback. The gap is unverified shape quality: no evidence ensures that nested, singleton, sparse, or mixed provider responses render useful facts/tables rather than technically structured but poor output.

**Recommendation:** export the trace formatter and add per-family fixtures generated from sanitized tool-result shapes. Minimum coverage is one fixture per public action plus malformed JSON, empty result, singleton array, heterogeneous array, and nested error. Prefer shape adapters over tool-name conditionals.

#### D3. Rendering ownership is split across two modules without a parity boundary

Trace rendering begins in `dashboard/js/reasoning.js`, while assistant/raw fallback rendering lives in `dashboard/js/response-renderer.js`. Pi-hole tests cover the latter deeply, but the former retains older hand-coded behavior. No test asserts that the two paths render the same underlying result with equivalent facts and safety.

**Recommendation:** define one normalized render model—facts, columns/rows, sections, warnings—and make both trace and assistant flows consume it. Add equivalence tests for representative Proxmox, OPNsense, and Pi-hole results.

## Cross-Family Root Causes

### 1. Family membership is implicit

Readonly actions live in schema enums, write actions in switch branches, atomic actions in files, production tools in the loader, render behavior in conditional code, and ingestion ownership in orchestrator conventions. There is no completeness boundary joining these representations.

The result is predictable: atomic classes can exist without production registration; schema actions can lack behavior tests/examples; ingestion sources can exist without cleanup semantics; result shapes can ship without rendering fixtures.

### 2. Metadata is descriptive rather than executable

Examples include “all operations require confirmation” beside `requiresConfirmation: false`, “rollback capability” without a compensation path, and IP-sanitization notes that contradict the canonical sanitizer. Prose duplicates runtime policy and drifts.

### 3. Failure is represented at multiple incompatible layers

Actions may return `success: false`, throw, or return a tool error. Ingestion may throw, return, log-and-return, or report degraded fields. The outer runners frequently reduce those forms to “exception versus no exception,” losing the semantics needed for recovery and cleanup.

### 4. Reconciliation is not coupled to authoritative-source health

Some ingestors have snapshot logic, some rely on global age cleanup, and some never delete. The scheduler invokes cleanup as a separate global phase without the source-health evidence necessary to know which absences are authoritative.

### 5. The newest UX work has stronger fixtures than the oldest paths

Pi-hole's rendering work was driven by explicit result-shape fixtures. Older Proxmox/OPNsense paths accumulated special cases and broad fuzz tests without an action-by-action parity matrix. Age produced breadth, not necessarily a safer current contract.

## Required Parity Standards

These standards are recommendations for a follow-up implementation pass. They are intentionally phrased as enforceable contracts rather than module-specific patches.

### P1. Production registration completeness

Every executable tool/action definition must map to exactly one registered production surface. CI must fail for an unregistered definition, a registered tool without a definition, or duplicate action exposure unless an explicit compatibility alias is declared.

### P2. One operation-policy source of truth

ACL, risk, confirmation, schema, examples, idempotency, and reversibility must be resolved from the same operation definition used at execution time. Tool-level defaults may only narrow access, never broaden an operation's policy.

### P3. Canonical execution-result adaptation

Underlying `{ success: false }`, thrown errors, timeouts, and partial failures must all become `ExecutionResult.error`. A completed/success event must be impossible when the underlying operation reports failure.

### P4. Mutation recovery declaration

Every write/action must declare one of: transactional, compensatable, idempotent retry, or irreversible. “Rollback” may appear in notes only when a tested recovery path exists. Multi-step compensatable actions must journal completed steps and compensate in reverse order.

### P5. Typed ingestion health and cleanup eligibility

Every ingestion run must return source health, destination health, authoritative scopes, counts, and one of `healthy`, `degraded`, or `failed`. Cleanup must consume that report and reconcile only healthy authoritative scopes.

### P6. Snapshot ownership for persistent entities

Every ingested entity/relationship type must declare its owner, source key, authoritative-empty behavior, removal policy, and stale policy. “Never delete” and “live-only” are permitted only as explicit reviewed decisions.

### P7. Result-shape rendering completeness

Each public tool action must have a sanitized result fixture proving trace and assistant rendering. All display values must pass through a shared escaping path. Malformed input must be escaped and visibly marked, never directly interpolated.

### P8. Action-level behavior coverage

Each schema action must have at least one dispatcher/adapter test. Writes additionally require dry-run, confirmation/policy, upstream failure, and audit-result assertions. Multi-step writes require injected failure after every mutation step.

### P9. Generated or verified operator notes

Examples, confirmation statements, sanitization claims, freshness, and recovery claims must either be generated from executable metadata or checked by contract tests against it. Canonical sanitization policy belongs in `src/agent/tool-sanitizer.ts`, not duplicated prose.

## Prioritized Remediation Plan

| Priority | Finding | Primary files | Acceptance evidence |
|---|---|---|---|
| P0 | Enforce per-action ACL/policy on the production action path | `src/agent/tool-loader.ts`, `src/tools/ActionTool.ts`, `src/agent/tool-policy.ts`, `src/tools/actions/*` | Production registry test; `ops` denied for admin-only compute/firewall/network actions |
| P0 | Map action `success: false` to tool failure | `src/tools/ActionTool.ts`, `src/tools/actions/*`, shared execution types | Contract test proves no success event/metric for returned failure |
| P0 | Gate stale cleanup by ingestion source health | `src/pce/scheduler/ingestion-scheduler.ts`, `src/twin/cleanup/stale-node-cleaner.ts`, ingestion result types | Scheduler test: two degraded cycles cannot delete failed-source entities |
| P1 | Fix firewall empty/failure reconciliation | `src/pce/ingestion/firewall-ingestion.ts` | Separate tests for failed fetch, healthy empty rules, empty relationships, removed alias |
| P1 | Escape or remove bespoke trace rendering | `dashboard/js/reasoning.js`, `dashboard/js/response-renderer.js` | Malicious value fixtures remain text in every path |
| P1 | Add action-by-action rendering fixtures | `tests/dashboard/`, readonly result fixtures | One fixture per Proxmox/OPNsense/Pi-hole action; trace/assistant equivalence |
| P1 | Adopt recovery declarations and compensation | `src/actions/`, action definition metadata | Failure-after-each-step tests for DHCP/DNS, firewall, netplan, and service actions |
| P1 | Add ingestion removal contracts for switch/topology | switch/topology orchestrators and twin/graph stores | Healthy removal reconciles; failed poll retains last known data with stale state |
| P2 | Unify readonly provenance and safe error logging | three readonly bases or shared helper | Contract suite asserts provenance fields and sanitized logs/errors |
| P2 | Repair notes and stale redaction tests | readonly/write schemas; Proxmox redaction tests | Notes match canonical sanitizer and runtime confirmation/rollback behavior |
| P2 | Enforce examples and behavior tests per schema action | tool schema registries and test helpers | CI completeness check fails on a newly declared untested action |

## Verification Performed

No production code was changed during this diagnostic pass. The audit document is the only intended new file.

`bun run --bun tsc --noEmit` completed successfully.

Targeted readonly/rendering/ingestion run:

```text
bun test tests/agent/tool-sanitizer.test.ts \
  tests/tools/proxmox/readonly/redaction.test.ts \
  tests/tools/pihole/readonly/pihole-readonly.test.ts \
  tests/dashboard/response-renderer.pihole.test.ts \
  tests/pce/ingestion/network-ingestion.test.ts --bail
```

Result: Pi-hole rendering (19), canonical sanitizer (2), network ingestion (2), and Pi-hole readonly (15) tests passed. The run then stopped on the first legacy Proxmox redaction expectation, which still requires `root@pam` to be redacted (`tests/tools/proxmox/readonly/redaction.test.ts:14`). Later assertions in that same suite also require IP/MAC redaction (`tests/tools/proxmox/readonly/redaction.test.ts:223-268`), directly contradicting the current canonical sanitizer policy.

Targeted action/write run:

```text
bun test tests/tools/actions/action-tools.test.ts \
  tests/tools/actions/action-docs-generator.test.ts \
  tests/tools/actions/application-lifecycle-tool.test.ts \
  tests/actions/application-lifecycle-executor.test.ts \
  tests/tools/proxmox/writes/proxmox-write-tool.test.ts \
  tests/tools/opnsense/writes/opnsense-safewrite.test.ts --bail
```

Result: **98 passed, 0 failed**. This does not negate findings A1-A5: the atomic tests instantiate classes directly rather than validating the production loader, and the public-operation gaps identified above have no behavior tests to fail.

## Conclusion

The repository already contains mature solutions for most of the missing contracts: atomic action metadata for fine-grained policy, application lifecycle journals for compensation, network snapshot guards for partial ingestion, Pi-hole fixtures for rendering quality, and Proxmox provenance for live reads. The principal architecture problem is that these solutions remain local exemplars rather than enforced family standards.

The next implementation pass should therefore avoid one-off parity patches. The durable sequence is:

1. establish production completeness and per-operation policy for actions;
2. make execution and ingestion failure states typed and lossless;
3. bind cleanup to authoritative source health;
4. centralize safe rendering and require per-action fixtures; and
5. enforce examples, behavior tests, provenance, and notes from the same registries that drive runtime behavior.

That turns “compare the newest sibling with the oldest” from a periodic forensic exercise into a CI-enforced property of every feature family.
