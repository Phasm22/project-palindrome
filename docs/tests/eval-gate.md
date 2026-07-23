# PCE Eval Gate

RM-20 promotes the deterministic part of the PCE evaluation harness into a
build gate while keeping live infrastructure out of the default test path.

## Offline gate (default and CI)

`bun test` discovers `tests/pce/eval/offline-gate.test.ts`. CI also runs that
file in the dedicated **Offline Eval Gate** job, without Neo4j, Qdrant,
OPNsense, Proxmox, an agent API, or an OpenAI key.

The gate reads the versioned fixture at
`tests/pce/eval/fixtures/offline-eval.snapshot.json`. It contains a compact
sample of six real traces selected from:

- `docs/tests/fuzz-corpus-2026-07-21.json`
- `docs/tests/fuzz-results-2026-07-21.jsonl`

The snapshot deliberately retains one historical
`failed_but_substantive_answer` finding. Its locked baseline is:

- PASS rate at least 83% (currently 5/6, or 83.33%)
- `flaggedCount` at most 1

A trace passes when neither deterministic check references its trace ID.
`flaggedCount` is the number of findings; the PASS-rate calculation
de-duplicates trace IDs when one finding covers multiple traces.

The test also loads `regressed-eval.snapshot.json`, a negative control with a
second failed-tool/substantive-answer case. The test succeeds only when that
fixture makes the gate fail both thresholds. An empty fixture also fails, so
removing all evidence cannot produce a vacuous pass.

Run only the offline gate:

```bash
bun test tests/pce/eval/offline-gate.test.ts
```

Treat baseline changes as reviewed evidence changes. Refresh a fixture from a
real captured trace, retain its source case ID, explain why a finding was added
or removed, and update the negative control when the check contract changes.
Do not raise thresholds merely to make a regression pass.

## Live corpus replay (explicit opt-in)

The package script is safe by default:

```bash
bun run eval:gate
```

Without `PCE_LIVE_EVAL=1`, it prints a skip message and does not contact an API,
start services, read live stores, or write results.

To replay the full committed corpus, first provide a populated Palindrome stack
whose agent API is reachable at `http://localhost:4000`, including the live
Neo4j data required by the corpus:

```bash
PCE_LIVE_EVAL=1 bun run eval:gate
```

The script invokes `scripts/fuzz-campaign-runner.ts`, writes raw JSONL under
the ignored `.pce-eval/` directory, extracts captured reasoning traces, and
applies the same deterministic gate used offline. It fails on a regression.
The corpus includes action-shaped prompts; the existing campaign marks those
as ask/confirm scenarios, but operators should still use a non-production test
stack and review the corpus before replay.

The default live thresholds are grounded in the committed 2026-07-21 capture:
94 of 107 captured traces passed the heuristics (87.85%), with seven findings.
The gate floors the rate at 87% and caps findings at seven. It also allows the
one historical capture failure caused by the deliberately empty-input case.

Optional controls:

| Variable | Default | Purpose |
|---|---:|---|
| `PCE_EVAL_CORPUS_PATH` | committed fuzz corpus | Alternate corpus JSON |
| `PCE_EVAL_RESULTS_PATH` | timestamped `.pce-eval/*.jsonl` | Raw live output |
| `PCE_EVAL_CONCURRENCY` | `5` | Concurrent live workers |
| `PCE_EVAL_ONLY` | all cases | Category or case-ID prefix filter |
| `PCE_EVAL_MIN_PASS_RATE` | `0.87` | Live heuristic PASS-rate floor |
| `PCE_EVAL_MAX_FLAGGED_COUNT` | `7` | Live finding ceiling |
| `PCE_EVAL_MAX_CAPTURE_FAILURES` | `1` | Live request/capture failure ceiling |

When filtering to a subset, set reviewed thresholds appropriate to that subset
instead of interpreting the full-corpus baseline as equivalent evidence.

## Scope of the signal

This gate operationalizes the existing deterministic checks:

- failed tool calls followed by substantive-looking data
- contradictory status answers for near-duplicate queries

It does **not** claim that every unflagged answer is semantically correct. The
full fuzz campaign still requires human grading against the independent Neo4j
ground-truth snapshot described in `fuzz-campaign-2026-07-21.md`. The live
script explicitly reports this limitation after a pass; it is a repeatable
regression gate, not an LLM or ground-truth judge.
