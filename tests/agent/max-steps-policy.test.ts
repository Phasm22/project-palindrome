import { expect, test } from "bun:test";
import {
  computeMaxSteps,
  isStuckOnEmptyStep,
  isDuplicateOnlyStep,
  shouldSynthesizeAtBoundary,
  BASE_MAX_STEPS,
  EXTENDED_MAX_STEPS,
  EMPTY_STEP_STUCK_THRESHOLD,
  MAX_STEPS_CANNED_MESSAGE,
} from "../../src/agent/handlers/handle-execute";

/**
 * Regression coverage for the MAX_STEPS policy decision (2026-07-21 fuzz campaign, Task 2).
 * See the "MAX_STEPS policy" comment block above computeMaxSteps() in handle-execute.ts, and
 * the dated section appended to docs/tests/fuzz-campaign-2026-07-21.md, for the full evidence
 * this decision is based on. handleExecute() itself has no dependency-injection seam for the
 * OpenAI client (module-level singleton, per the project's existing documented convention for
 * this file), so — consistent with how the original campaign treated this same file — the pure
 * decision helpers are unit-tested here and the full loop wiring is verified via live
 * re-verification instead of a mocked end-to-end unit test.
 */

test("BASE_MAX_STEPS is the previously-documented default of 5", () => {
  expect(BASE_MAX_STEPS).toBe(5);
});

test("computeMaxSteps keeps the base budget for an ordinary single-answer query", () => {
  const steps = computeMaxSteps({
    isCompositeQuery: false,
    isAllNodesQuery: false,
    userInput: "What's the uptime of pihole?",
  });
  expect(steps).toBe(BASE_MAX_STEPS);
});

test("computeMaxSteps extends the budget for composite (multi-dimension) queries", () => {
  const steps = computeMaxSteps({
    isCompositeQuery: true,
    isAllNodesQuery: false,
    userInput: "VMs on yang and their exposure level",
  });
  expect(steps).toBe(EXTENDED_MAX_STEPS);
});

test("computeMaxSteps extends the budget for 'all nodes' sweep queries", () => {
  const steps = computeMaxSteps({
    isCompositeQuery: false,
    isAllNodesQuery: true,
    userInput: "temperature of all nodes",
  });
  expect(steps).toBe(EXTENDED_MAX_STEPS);
});

test("computeMaxSteps extends the budget for explicit full/complete diagnostic requests", () => {
  // RV-ROUTING-04 from the campaign: real, live MAXSTEPS hit that showed genuine forward
  // progress (12 tool calls, final ones succeeding) cut short by the flat 5-step budget.
  const steps = computeMaxSteps({
    isCompositeQuery: false,
    isAllNodesQuery: false,
    userInput: "Run a full health diagnostic on windowsVM.",
  });
  expect(steps).toBe(EXTENDED_MAX_STEPS);
});

test("computeMaxSteps extends the budget for 'for every/each X' iteration queries", () => {
  // RV-CRASH-05 from the campaign: needed to iterate per-node data before answering.
  const steps = computeMaxSteps({
    isCompositeQuery: false,
    isAllNodesQuery: false,
    userInput: "For every stopped VM, tell me which node it's on and whether any firewall rule references it.",
  });
  expect(steps).toBe(EXTENDED_MAX_STEPS);
});

test("computeMaxSteps does NOT extend the budget for a thrashing-prone single tool query", () => {
  // RV-ROUTING-03 from the campaign: the same failing tool call repeated with cosmetic
  // param changes. More budget would only make the (identical) eventual failure slower.
  const steps = computeMaxSteps({
    isCompositeQuery: false,
    isAllNodesQuery: false,
    userInput: "Traceroute to 8.8.8.8.",
  });
  expect(steps).toBe(BASE_MAX_STEPS);
});

test("isStuckOnEmptyStep is false below the threshold", () => {
  expect(isStuckOnEmptyStep(0)).toBe(false);
  expect(isStuckOnEmptyStep(1)).toBe(false);
});

test("isStuckOnEmptyStep is true at and above the threshold", () => {
  expect(EMPTY_STEP_STUCK_THRESHOLD).toBe(2);
  expect(isStuckOnEmptyStep(2)).toBe(true);
  expect(isStuckOnEmptyStep(3)).toBe(true);
});

test("isStuckOnEmptyStep respects a custom threshold", () => {
  expect(isStuckOnEmptyStep(2, 3)).toBe(false);
  expect(isStuckOnEmptyStep(3, 3)).toBe(true);
});

/**
 * Residual 1 — duplicate-call thrashing (2026-07-21 fuzz campaign residual).
 * A step where the LLM emitted tool_calls but every one was filtered as an exact duplicate
 * (RV-CRASH-05 steps 4/5/7/8, F-08 step 2 — live-reproduced this session) makes zero forward
 * progress yet, before this fix, never tripped isStuckOnEmptyStep because the raw response
 * carried tool_calls. isDuplicateOnlyStep() is the pure predicate folding it into the same
 * stuck-detection budget.
 */
test("isDuplicateOnlyStep is true when every emitted tool call was a duplicate", () => {
  // RV-CRASH-05 step 4/5: 3 tool calls, all filtered as duplicates, none executed.
  expect(isDuplicateOnlyStep({ toolCallCount: 3, duplicateCount: 3, executedCount: 0 })).toBe(true);
  // RV-CRASH-05 step 7/8, F-08 step 2: a single duplicate-only call.
  expect(isDuplicateOnlyStep({ toolCallCount: 1, duplicateCount: 1, executedCount: 0 })).toBe(true);
});

test("isDuplicateOnlyStep is false when at least one call actually executed", () => {
  // RV-CRASH-05 step 3/6: a real tool call alongside duplicates is still forward progress.
  expect(isDuplicateOnlyStep({ toolCallCount: 4, duplicateCount: 3, executedCount: 1 })).toBe(false);
  expect(isDuplicateOnlyStep({ toolCallCount: 2, duplicateCount: 0, executedCount: 2 })).toBe(false);
});

test("isDuplicateOnlyStep is false for a step with no tool calls or no duplicates", () => {
  // A genuinely empty step (no tool_calls) is handled by the empty-step guard, not this one.
  expect(isDuplicateOnlyStep({ toolCallCount: 0, duplicateCount: 0, executedCount: 0 })).toBe(false);
  // A step with tool calls that all failed to parse (but weren't duplicates) is not this stall.
  expect(isDuplicateOnlyStep({ toolCallCount: 2, duplicateCount: 0, executedCount: 0 })).toBe(false);
});

/**
 * Residual 2 — boundary-synthesis discard (2026-07-21 fuzz campaign residual).
 * shouldSynthesizeAtBoundary() gates the final tool-free synthesis LLM call on "at least one
 * tool call succeeded this run" (RV-CRASH-03/RV-CRASH-05 reached the budget holding real,
 * answerable data). With zero successful data the canned message stays the honest answer.
 */
test("shouldSynthesizeAtBoundary is true only when a tool call succeeded this run", () => {
  expect(shouldSynthesizeAtBoundary(1)).toBe(true);
  expect(shouldSynthesizeAtBoundary(5)).toBe(true);
});

test("shouldSynthesizeAtBoundary is false with no successful tool data", () => {
  expect(shouldSynthesizeAtBoundary(0)).toBe(false);
});

test("MAX_STEPS_CANNED_MESSAGE is unchanged from the documented fallback text", () => {
  expect(MAX_STEPS_CANNED_MESSAGE).toBe("Max reasoning depth reached. Please try a simpler query.");
});
