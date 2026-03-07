# Canonical Response Format Removal Notes

## Current dependency shape

`src/agent/canonical-response-format.ts` is effectively a single-consumer module today. The only live importer is [response-formatter.ts](/home/tj/project-palindrome/src/agent/response-formatter.ts).

## Call-site inventory

| Call site | Current role | Classification |
|---|---|---|
| [response-formatter.ts:177](/home/tj/project-palindrome/src/agent/response-formatter.ts#L177) | `formatCountAnswer()` in `normalizeCountPackaging()` forces `how many ...` replies into one-line canonical count text. | Replaceable during `P1.3` |
| [response-formatter.ts:308](/home/tj/project-palindrome/src/agent/response-formatter.ts#L308), [response-formatter.ts:310](/home/tj/project-palindrome/src/agent/response-formatter.ts#L310) | `parseEntityListSection()` and `buildEntityListSection()` round-trip already-canonical text back into normalized canonical text. | Dead-code candidate after `P1.3` |
| [response-formatter.ts:314](/home/tj/project-palindrome/src/agent/response-formatter.ts#L314), [response-formatter.ts:319](/home/tj/project-palindrome/src/agent/response-formatter.ts#L319), [response-formatter.ts:360](/home/tj/project-palindrome/src/agent/response-formatter.ts#L360), [response-formatter.ts:373](/home/tj/project-palindrome/src/agent/response-formatter.ts#L373) | `EntityListEntry`, `parseEntityLine()`, and `buildEntityListSection()` convert status/uptime/compute-list text into canonical entity-list text. | Still needed before `P1.3` |
| [response-formatter.ts:54](/home/tj/project-palindrome/src/agent/response-formatter.ts#L54), [response-formatter.ts:804](/home/tj/project-palindrome/src/agent/response-formatter.ts#L804) | Prompt-level semantic coupling to the same canonical text contract. | Replaceable during `P1.3` |

## Test coverage gaps

- No tests import `canonical-response-format.ts` directly.
- [response-formatter-adaptive.test.ts](/home/tj/project-palindrome/tests/agent/response-formatter-adaptive.test.ts) covers VM inventory packaging, but that path does not depend on `canonical-response-format.ts`.
- [response-formatter.test.ts](/home/tj/project-palindrome/tests/agent/response-formatter.test.ts) is too loose to pin canonical count or entity-list behavior.
- There is currently no formatter test coverage for canonical count output or canonical entity-list normalization.

## Removal order

1. In `P1.3`, replace count/status/compute-list text packaging with typed `AgentResponseV1` sections and add contract tests there.
2. Remove the prompt text that asks for canonical entity-list output and drop `formatCountAnswer()` usage at [response-formatter.ts:177](/home/tj/project-palindrome/src/agent/response-formatter.ts#L177).
3. Remove the entity-list round-trip block at [response-formatter.ts:308](/home/tj/project-palindrome/src/agent/response-formatter.ts#L308).
4. Remove the remaining entity extraction/serialization path at [response-formatter.ts:314](/home/tj/project-palindrome/src/agent/response-formatter.ts#L314) and [response-formatter.ts:373](/home/tj/project-palindrome/src/agent/response-formatter.ts#L373), then delete `canonical-response-format.ts`.

## Note

The header comment in [canonical-response-format.ts](/home/tj/project-palindrome/src/agent/canonical-response-format.ts) says the module is shared by the formatter and dashboard. I found no current dashboard import, so that comment is stale.
