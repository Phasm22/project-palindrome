# Intent Classification: Standards for a System That Keeps Getting Extended

**Status:** canonical standards and implemented architecture, written and adopted
2026-07-22. Supersedes `INTENT_ARCHITECTURE.md`, `CONFIDENCE_THRESHOLDS.md`, and
`REFACTOR_SUMMARY.md`. `FAILURE_RECLASSIFICATION.md` remains a live companion for
post-tool-failure behavior (see "What to do with the old docs" at the end).

## Implemented contract

The production pipeline is three explicitly separate, sequential stages:

1. **Intent classification** produces `IntentClassification`, including
   `classificationMethod` so confidence provenance is never implicit. The LLM is
   authoritative when configured. The Jaccard classifier runs only when the API key
   is missing or structured classification throws; low LLM confidence does not
   trigger fallback. This contract is exported as `CLASSIFIER_FALLBACK_CONTRACT`.
2. **Intent routing** consumes classification and applies the confidence profile for
   that classifier signal. Jaccard retains its legacy thresholds (metrics/query/
   action/destructive/chat: 0.15/0.30/0.50/0.70/0.30). LLM self-confidence uses a
   separately named conservative profile (0.30/0.50/0.65/0.80/0.50). Routing chooses
   direct handler, LLM reasoning, or routing clarification; it does not decide the
   user-facing dialog act.
3. **Dialog-act policy** consumes classification, routing, missing slots, risk, and
   pending-confirmation state to choose `ASK_CLARIFY`, `ASK_CONFIRM`, `EXECUTE`, or
   `RESPOND_ONLY`. It does not calibrate classifier confidence.

`domain-taxonomy.ts` is the sole domain declaration. Loaded tools colocate per-domain
classification entries in `ToolMetadata`; `classifier-registry.ts` assembles trigger
patterns, parity probes, retrieval keywords, tool-first eligibility, and composite
participation. `domain-consumers.ts` records explicit support or reasoned opt-outs for
non-tool-derived consumers. `domain-taxonomy-completeness.test.ts` enforces the whole
contract.

To add a domain, add it once to `DOMAINS`, add classification metadata to the owning
tool, and resolve every compile/test failure with either support or a reviewed opt-out.
Any new detector regex/keyword must include a plausible non-match test per S7.

## Why this document exists

The classification/routing pipeline (`src/reasoning/`, plus the parts of
`src/agent/runner.ts` and `dialog-policy.ts` that consume its output) has needed a
hand-edit almost every time a tool or domain was added, for about 8 months straight
(first commit touching this pipeline: `c00371b`, 2025-11-14; most recent: `858b3c7`,
2026-07-22, today). That's not a bug in any one commit — it's the system working
exactly as designed, and the design doesn't scale. This doc identifies *why*, with
evidence, and lays out standards a rebuild must satisfy so the next 8 months don't
repeat the last 8.

The core failure, stated once up front: **there is no single source of truth for
"what domains/tools exist and what each one needs," so every consumer of that
information maintains its own hand-copied, independently-drifting list.** Everything
below is a consequence of that one fact.

## Evidence (pre-adoption snapshot)

The evidence and root-cause sections below preserve the state observed immediately
before this implementation landed. References such as "currently shipping" describe
that snapshot; the implemented contract above and tests now close those gaps.

### 1. A live, currently-shipping bug that proves the pattern

`src/reasoning/intent-schema.ts:23-24` — the Zod schema for the LLM-based classifier
(the *primary* classification path today, gating only on `OPENAI_API_KEY` being set):

```ts
domain: z.enum(["compute", "network", "firewall", "metrics", "general"]).optional()
```

There is no `"dns"`. The `pihole_readonly` tool has existed since commit `858b3c7`
(today). **The LLM classifier can structurally never emit `domain: "dns"`** — not a
prompt-tuning problem, a schema problem. Every DNS query gets classified with
`domain: undefined` or misassigned to another domain by the LLM, and only works at
all because a *second*, independent regex-based classifier (`intent-classifier.ts`)
happens to have DNS support and gets consulted elsewhere in the pipeline. This one
`enum(...)` call is the concrete artifact of the whole problem: DNS was added to the
files that were top-of-mind while writing the Pi-hole tool, and silently skipped in
the ones that weren't.

### 2. Five independent domain lists, already drifted

No `type Domain` or `const DOMAINS` exists anywhere in the codebase. Five files each
hand-maintain their own set, none importing from another:

| Location | Domains it knows about |
|---|---|
| `intent-classifier.ts:50` (type) + `:345-353` (regex dict) | compute, network, firewall, metrics, **dns**, general |
| `intent-schema.ts:23-24` (LLM Zod enum — **primary path**) | compute, network, firewall, metrics, general — **no dns** |
| `retrieval-eligibility.ts:7` (`TOOL_FIRST_DOMAINS`) | compute, network, firewall, metrics, **dns** |
| `runner.ts:266-271` (`hasDomainMatch` keywords) | compute, network, firewall, metrics — **no dns** |
| `intent-router.ts:456-460`, `:519-523` (inline fallback domain inference) | compute, network, firewall only — no metrics, no dns |

Zero of these import from a shared source. A sixth consumer,
`runner.ts`'s twin-first domain-gate blocks (~lines 2051-2243, one hand-written
`if (domain === "compute") {...}` / `"firewall"` / `"network"` block each, each with
its own `src/reasoning/chains/<domain>.ts` file), has **no `dns` branch and no
`chains/dns.ts`** — not an oversight worth fixing in isolation, a *structural*
consequence of there being six-plus places that each need their own manual entry
with no mechanism connecting them.

### 3. The worked example: adding "dns" end-to-end (commit `858b3c7`)

What DNS *did* get, in the commit that added it:
- `intent-classifier.ts` — widened the domain type, added a `dns` regex (ordered
  *before* the `network` regex specifically so "DNS record" queries don't fall into
  the broader network match — a manually-managed ordering dependency, not something
  the type system or a test protects)
- `retrieval-eligibility.ts` — added to `TOOL_FIRST_DOMAINS`
- `composite-query.ts` — added a `.includes("dns")` check for step-budget extension
- `tool-loader.ts` — registered `PiholeReadOnlyTool`

What DNS *didn't* get, in the same commit or any since:
- `intent-schema.ts`'s LLM enum (§1, above)
- `runner.ts`'s `hasDomainMatch` keyword map
- `runner.ts`'s clarification-suggestion `if/else` chain (~lines 1440-1448)
- `runner.ts`'s twin-first domain-gate + `chains/dns.ts`
- `intent-router.ts`'s `routeQueryIntent()` direct-handler dispatch (only has
  branches for compute/firewall/network)

The commit message for `858b3c7` says the bug it fixed was a real user query ("Show
me all DNS records") getting routed to the wrong tool, 404ing, and the agent
presenting DHCP/ARP data mislabeled as DNS records — a hallucination-after-failure
directly caused by DNS being *known* to some parts of the pipeline and *invisible* to
others. **This will recur for the next domain**, because nothing changed about how
domains get registered; only this one instance got patched.

For comparison, `firewall` and `compute` — the oldest, most-used domains — appear in
every one of the locations above, including the LLM schema enum and the domain-gate
chain files. That's not because firewall/compute were built more carefully; it's
because they've had 8 months and multiple bug-fix cycles to accumulate coverage that
DNS (1 day old) hasn't had yet. Every new domain starts back at zero and has to
independently rediscover which of the 6+ files it needs to touch.

### 4. Two classifiers, one threshold system, no reconciliation

`intent-router.ts` has two entry points:
- `classifyAndRoute()` (sync) — the *original* design: Jaccard word-overlap
  similarity against hand-written example sentences (`intent-classifier.ts`'s
  `INTENT_ARCHETYPES`), now a fallback.
- `classifyAndRouteWithLLM()` — `generateObject` against the schema in §1, now
  primary. Falls back to the Jaccard path only if `OPENAI_API_KEY` is unset or the
  call throws — **never** on low LLM confidence.

Both funnel into the *same* threshold constants (`getConfidenceThreshold`,
`ConfidenceLevel`, 0.15/0.30/0.50/0.70/0.80 — these do still match
`CONFIDENCE_THRESHOLDS.md`, so that doc isn't wrong on the numbers). But those
thresholds were originally calibrated against Jaccard word-overlap scores, which
behave nothing like an LLM's self-reported 0-1 confidence field — and nothing in the
code or docs acknowledges that the *meaning* of "0.55 confidence" changed when the
primary classifier changed underneath it. Nobody re-validated the thresholds against
the new signal; they just kept applying.

Separately, `isClearInformationalQuery()`'s bypass logic is duplicated **verbatim**
between the two entry points (`intent-router.ts:444-464` and `:508-527`) — two
copies of the same logic, one per code path, that will drift the next time either
gets edited without the other.

### 5. A second decision layer nobody wrote a doc for

`CONFIDENCE_THRESHOLDS.md` describes routing (direct_handler vs. llm_reasoning vs.
clarification) — but the function that actually decides `ASK_CLARIFY` /
`ASK_CONFIRM` / `EXECUTE` / `RESPOND_ONLY` for the user-facing conversation,
`evaluateDialogPolicy()` in `src/agent/dialog-policy.ts:101-165`, **uses none of
those threshold constants**. It's driven entirely by booleans:
`intent.intent === "CLARIFICATION"`, `intent.missing.length > 0`,
`routing?.route === "clarification"`, `intent.risk === "WRITE_HIGH"|"DESTRUCTIVE"`,
and a strict `CONFIRM <id>` match against a 15-minute-TTL pending action.

This is the actual mechanism behind the flaky `runner-confirmation-flow.test.ts`
tests investigated in the previous session: `intent.missing` is populated by the LLM
classifier's own judgment call on a borderline compound request, and that judgment
call varies run to run (LLM sampling), which flips `needsClarification` even though
`evaluateDialogPolicy()` itself is a pure function. Two structurally separate
decision systems — one documented (and now half-stale), one undocumented — with
names ("clarification," "confidence") that sound like they're the same concept and
aren't.

### 6. Five detector files, five different internal designs

`detectNetworkIntent.ts`, `detectFirewallIntent.ts`, `compute-intents.ts`,
`detectExposureIntent.ts`, `action-intents.ts` all share the surface shape
`(input: string) => SomeType | null`, and nothing else:

- `action-intents.ts` alone has adversarial-input hardening
  (`isPlausibleNameCandidate`, `hasLeadingDestructiveVerb`, `COMMAND_OPENER_WORDS`,
  lines 45-93) — built after live fuzz-testing found prompt-injection-flavored
  bypasses, never back-ported to the other four detectors, which remain exposed to
  the same class of input.
- `detectNetworkIntent.ts` alone excludes action verbs via a local
  `hasActionKeyword` list (lines 64-73) that **duplicates** `action-intents.ts`'s own
  keyword sets instead of importing them.
- `detectFirewallIntent.ts` alone computes `isQuestion` via regex to suppress
  false action-matches (line 174); `compute-intents.ts` has no equivalent guard and,
  per its own code comment, some of its `if` blocks are dead ("These are now handled
  above in the priority check," line 222).
- Node-name lists are hand-duplicated: `compute-intents.ts:13`
  (`KNOWN_NODE_NAMES`) and a *second*, separately-typed array at line 63 in the same
  file — which contains `"proxbig"` twice, a live copy-paste bug nobody would catch
  because nothing validates the two lists agree.
- VM-ID extraction has **four independent regex families** for the identical
  concept, in `compute-intents.ts:77-83`, `action-intents.ts:189-199`,
  `detectExposureIntent.ts:23-25`, and `detectFirewallIntent.ts:27-48`.

This is what "copy the sibling file as a starting template, then organically
diverge" looks like after several iterations, and it's why hardening or bug fixes
discovered in one detector don't propagate to the others.

### 7. The reactive-patch cycle is visible in the commit log, not just inferred

`2d7b38f` and `b8cdc34` — both 2026-07-21, three hours apart, the day *before*
today's Pi-hole commit — are explicitly framed as fixing regressions from earlier
ad-hoc regex additions: a greedy `extractAliasName()` "capturing the rest of the
sentence," `isClearInformationalQuery()` bypass patterns needing widening after being
too narrow, CIDR string-equality standing in for real subnet containment. This is a
recurring failure mode of hand-written regex/keyword detection generally, not a
string of unrelated bugs — every new regex is a new opportunity to be too greedy or
too narrow, discovered only after it ships and a real query hits the gap.

`93a5ca7` (2026-01-28) is a single commit that touched 5 of the 7 highest-churn
files at once (`tool-loader.ts`, `action-intents.ts`, `compute-intents.ts`,
`intent-router.ts` — including a breaking rename of the `CHAT` intent type into
`CHAT_SOCIAL`/`CHAT_REASONING` — and `intent-classifier.ts`, +230 lines, the largest
single-commit rewrite in the set). One upstream change, five files, in one commit,
because there was no way to make the change in fewer places.

Even `tool-loader.ts` itself — the *simplest* file in this list, structurally just a
flat array of `new XTool()` calls — flip-flopped design within hours on its first day
(`c00371b` then `faf3b4d`, both 2025-11-14: dynamic `fs.readdirSync` autoloader
replaced by a static array), and later had a tool (`GlancesTool`) added and then
fully removed (`2449a7e`). Low-risk mechanically, but every commit that adds a tool
here has a matching commit somewhere in the classification files, by necessity —
tool-loader.ts is not the bottleneck; it's the trigger for the real multiplier.

## Root causes

1. **No single source of truth for the domain taxonomy.** Five independent copies,
   drifted, with no mechanism (import, generated code, or test) tying them together.
2. **No colocation.** A tool's classification metadata (domain, keywords,
   tool-first eligibility, composite-query participation) lives in files structurally
   distant from the tool's own definition. Writing a tool and registering its
   classification behavior are two unconnected acts that happen to need to occur
   near each other in time, enforced by nothing but a developer's memory.
3. **No completeness enforcement.** Nothing — not the type system, not a test,
   not a lint rule — fails when a domain is added to one consuming location and
   skipped in another. The DNS enum gap (§1) would have been caught in seconds by a
   test that iterates the canonical domain list and checks every known consumer;
   instead it shipped and was found by a real user's hallucinated answer.
4. **Two classifiers, one un-revalidated threshold system.** The LLM classifier
   became primary without anyone re-deriving or re-stating what the existing
   confidence thresholds mean against a fundamentally different confidence signal.
5. **Two decision layers, confusable vocabulary, one documented.** Routing
   thresholds (`intent-router.ts`) and dialog-act policy (`dialog-policy.ts`) are
   separate mechanisms that both use words like "clarification" and "confidence,"
   with only the first ever written up — so the doc that exists is incomplete in a
   way that isn't visible from reading it alone.
6. **Detectors copy-pasted, not built on a shared toolkit.** Hardening and bug
   fixes discovered in one domain's detector don't reach the others because there's
   no shared base each one is built from — only a shared *shape* they happen to
   share by convention.
7. **Docs written once, never revisited.** `INTENT_ARCHITECTURE.md`,
   `CONFIDENCE_THRESHOLDS.md`, and `REFACTOR_SUMMARY.md` describe a Jaccard-only
   design from before the LLM classifier existed. They weren't wrong when written;
   nothing forced them to be touched when the architecture underneath them changed,
   so they silently became misleading instead of just incomplete.

## Standards

These are durable rules for how this system must be built and extended going
forward — not a one-time cleanup checklist. Any future PR touching classification,
routing, or tool registration should be checked against these.

### S1. One canonical domain taxonomy, and only one

There must be exactly one file defining the domain set (e.g.
`src/reasoning/domain-taxonomy.ts`, exporting `const DOMAINS = [...] as const` and
`type Domain = typeof DOMAINS[number]`). Every other location that needs a domain
list — the LLM Zod schema, `TOOL_FIRST_DOMAINS`, `hasDomainMatch`'s keyword map, the
Jaccard classifier's regex dict, any future consumer — **must derive from this
export**, never redeclare its own union or array. A domain that isn't in this one
file does not exist anywhere in the system.

### S2. Classification metadata is colocated with the tool, not centralized by hand

A tool declares its own domain(s), trigger keywords/phrases, `toolFirst` eligibility,
and composite-query participation as part of its own definition (e.g., an extension
to `ToolMetadata` on `BaseTool`), at the point where the tool itself is written. The
central registries (`TOOL_FIRST_DOMAINS`, the LLM schema's domain enum, keyword maps)
are **generated or assembled from the loaded tool registry at startup**, not
hand-copied into a second location. Registering a tool and registering its
classification behavior become the same act, not two acts a developer has to
remember to keep in sync.

### S3. Every domain-consuming location must be enumerable, and completeness must be a test, not a memory exercise

There must be a test (e.g.
`tests/reasoning/domain-taxonomy-completeness.test.ts`) that iterates
`DOMAINS` from S1 and asserts every known consumer either has an entry for that
domain or an explicit, reviewed opt-out (not every domain necessarily needs
tool-first treatment or a twin-first chain — but that must be a *decision*, not a
gap). This test must fail loudly in CI the moment a new domain is added without full
propagation — turning what happened with DNS (silent gap, discovered via a live
user's hallucinated answer three weeks after ship) into a compile/test failure before
merge.

### S4. One classification path is authoritative; a fallback's contract must be explicit and tested

If two classifiers (LLM-based, regex/Jaccard-based) are kept, document — in code,
not just in a doc file — exactly when the fallback triggers (today: missing API key
or thrown exception, not low confidence) and add a test asserting the fallback
produces domain/intent coverage **at least as complete** as the primary path (this
would have caught the DNS schema gap directly: the Jaccard classifier supports DNS,
the primary LLM path's schema doesn't, and a parity test between the two would fail
on that mismatch by construction). If the two paths' confidence scores aren't
comparable (they aren't today — Jaccard word-overlap vs. LLM self-report), the
threshold system must be re-derived per-path or the doc describing it must say
explicitly that thresholds only apply to one of the two paths.

### S5. Name and document decision layers as separate, sequential stages

Routing thresholds and dialog-act policy (`ASK_CLARIFY`/`ASK_CONFIRM`/`EXECUTE`)
are different concerns and must be documented as two explicitly-named, sequential
stages with a stated contract for what each is responsible for and what it hands to
the next. Any doc describing thresholds must say precisely which stage it governs.
If a stage's decision logic changes to no longer use a documented mechanism (e.g.
dialog-policy.ts stopped reading confidence thresholds at some point), the doc must
be updated in the same change — not left describing a mechanism the code no longer
uses.

### S6. Detectors are built from a shared toolkit, not copy-pasted from a sibling

Adversarial-input hardening, node-name resolution, VM-ID extraction, and
action-verb exclusion must each have exactly one implementation, imported by every
detector that needs it — not independently reimplemented per domain file. A
hardening fix discovered for one domain (e.g. `action-intents.ts`'s
prompt-injection-flavored bypass hardening) must be structurally available to every
other detector by virtue of using the same shared function, not something that has to
be separately remembered and back-ported.

### S7. Regex/keyword additions require an adversarial test case, on principle

Every new hand-written regex or keyword added to a detector must ship with at least
one test case demonstrating it does *not* match a plausible near-miss (the greedy
`extractAliasName()` failure mode, the CIDR-string-equality failure mode). This is
process discipline, not tooling — but it directly targets the specific failure mode
that produced the 2026-07-21 same-day double bug-fix cycle (§7 of Evidence).

### S8. Docs live next to the code, are updated in the same change, and dead docs are marked dead

An architecture doc for this subsystem must be updated in the same commit as any
change to the mechanism it describes, or it must be deleted/marked
deprecated-with-a-pointer the moment it stops matching reality — never left in place
to silently misrepresent the system to the next reader (human or agent). Prefer
generating documentation (e.g., a "supported domains" table) from S1's canonical
source over hand-written prose that can drift.

## Target architecture sketch

This is illustrative, not a spec to copy verbatim — enough to make S1-S3 concrete
for whoever implements this.

```
src/reasoning/domain-taxonomy.ts       # S1: single source of truth
  export const DOMAINS = ["compute","network","firewall","metrics","dns", ...] as const
  export type Domain = typeof DOMAINS[number]

src/tools/BaseTool.ts                  # S2: ToolMetadata gains classification fields
  interface ToolMetadata {
    ...
    domains?: Domain[]
    triggerKeywords?: RegExp[]
    toolFirst?: boolean
    compositeEligible?: boolean
  }

src/agent/tool-loader.ts               # unchanged mechanically, but its output
                                        # now IS the registry other files derive from

src/reasoning/classifier-registry.ts   # NEW: built once at startup from loadTools()
  export function buildToolFirstDomains(tools: BaseTool[]): Domain[]
  export function buildDomainKeywordMap(tools: BaseTool[]): Record<Domain, RegExp[]>
  # intent-schema.ts's z.enum(...) sources from DOMAINS directly, not a hand-copied list

tests/reasoning/domain-taxonomy-completeness.test.ts   # S3: the enforcement test
```

## Migration / adoption notes

**Adoption completed 2026-07-22.** The sequence below is retained to explain how the
implementation was landed and how similarly broad migrations should be staged.

- This doesn't need to land as one large PR. S1 (extract the canonical taxonomy) and
  S3 (the completeness test, initially asserting today's *actual* — inconsistent —
  state, then tightened) can land first and immediately stop new drift, before S2's
  larger tool-registration refactor is attempted.
- The DNS schema gap (§1) is a real, currently-shipping bug independent of the
  larger refactor and can be fixed today in isolation (add `"dns"` to
  `intent-schema.ts`'s enum) without waiting on S1-S8.
- The `KNOWN_NODE_NAMES` duplicate-`"proxbig"` bug (§6) is likewise a trivial,
  independent fix.

## What to do with the old docs

`INTENT_ARCHITECTURE.md`, `CONFIDENCE_THRESHOLDS.md`, and `REFACTOR_SUMMARY.md`
describe the pre-LLM-classifier design and should be deleted or moved to an
`archive/` subdirectory with a one-line pointer to this doc — not left as-is, per
S8. `CONFIDENCE_THRESHOLDS.md`'s numeric thresholds are still technically accurate
for `intent-router.ts`'s routing layer (§4/§5 above), so if kept, it must be
corrected to (a) state it only covers the routing stage, not dialog-act policy, and
(b) note the LLM classifier now supplies the confidence values the thresholds are
applied to, un-recalibrated. `FAILURE_RECLASSIFICATION.md` describes a mechanism
(`reclassifyIntentWithContext`, `FailureTracker`) not covered by this audit — worth a
separate pass to confirm it's still live and accurate before deciding its fate.

Implementation disposition: the three pre-LLM documents were removed; their history
remains in Git and `archive/README.md` points here. The failure-reclassification code
is live in `failure-reclassification.ts` and is called by
`agent/handlers/handle-execute.ts`; its companion document was retained and annotated
after that verification.
