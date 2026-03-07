# Domain Detector Waterfall Audit

## Summary

The LLM classifier/router already runs before the manual detector waterfall in [runner.ts](/home/tj/project-palindrome/src/agent/runner.ts). `runner.ts` then re-runs the same detector family inside clarification bypasses and again inside the main direct-handler waterfall instead of consuming the router's direct-handler result.

That creates three buckets:

- Required fast-paths: `exposure`, `firewall`
- Validator candidates: clarification bypass checks plus `compute` and `network` in the main waterfall
- Redundant bypasses: the `routing.clarification` detector block

## Audit matrix

| Ref | Detector | Site | Classification | Rationale |
|---|---|---|---|---|
| [runner.ts:1274](/home/tj/project-palindrome/src/agent/runner.ts#L1274) | `detectFirewallIntent` | `ASK_CLARIFY` bypass | Validator candidate | Useful as a clarification veto, but this is not an execution path and should not behave as a second classifier. |
| [runner.ts:1275](/home/tj/project-palindrome/src/agent/runner.ts#L1275) | `detectNetworkIntent` | `ASK_CLARIFY` bypass | Validator candidate | Same clarification-only role. |
| [runner.ts:1276](/home/tj/project-palindrome/src/agent/runner.ts#L1276) | `detectComputeIntent` | `ASK_CLARIFY` bypass | Validator candidate | Broad detector; later carve-outs show it should validate, not override classification. |
| [runner.ts:1277](/home/tj/project-palindrome/src/agent/runner.ts#L1277) | `detectExposureIntent` | `ASK_CLARIFY` bypass | Validator candidate | Cross-domain and useful as a veto, but still a clarification validator rather than a fast-path. |
| [runner.ts:1305](/home/tj/project-palindrome/src/agent/runner.ts#L1305) | `detectFirewallIntent` | `routing.clarification` bypass | Redundant | Dialog policy already maps `routing.route === "clarification"` to `ASK_CLARIFY`, so this second gate adds no new branch. |
| [runner.ts:1306](/home/tj/project-palindrome/src/agent/runner.ts#L1306) | `detectNetworkIntent` | `routing.clarification` bypass | Redundant | Same duplication. |
| [runner.ts:1307](/home/tj/project-palindrome/src/agent/runner.ts#L1307) | `detectComputeIntent` | `routing.clarification` bypass | Redundant | Same duplication. |
| [runner.ts:1308](/home/tj/project-palindrome/src/agent/runner.ts#L1308) | `detectExposureIntent` | `routing.clarification` bypass | Redundant | Same duplication. |
| [runner.ts:1906](/home/tj/project-palindrome/src/agent/runner.ts#L1906) | `detectExposureIntent` | Main waterfall direct handler | Required fast-path | Cross-domain and more specific than compute/firewall/network. |
| [runner.ts:1954](/home/tj/project-palindrome/src/agent/runner.ts#L1954) | `detectComputeIntent` | Main waterfall direct handler | Validator candidate | Operationally useful today, but semantically too broad to remain an unconditional override. |
| [runner.ts:1987](/home/tj/project-palindrome/src/agent/runner.ts#L1987) | `detectFirewallIntent` | Main waterfall direct handler | Required fast-path | Still valuable because natural-language reachability queries are misclassified often enough to justify a deterministic escape hatch. |
| [runner.ts:2028](/home/tj/project-palindrome/src/agent/runner.ts#L2028) | `detectNetworkIntent` | Main waterfall direct handler | Validator candidate | Useful for deterministic read-only lookups, but the detector is heuristic-heavy and should be gated. |

## Structural issue

The main cleanup target is not individual regexes. It is the fact that [runner.ts](/home/tj/project-palindrome/src/agent/runner.ts) re-runs detectors instead of consuming the router's direct-handler result. Several current bypasses are compensating for that missing handoff rather than representing distinct intent logic.
