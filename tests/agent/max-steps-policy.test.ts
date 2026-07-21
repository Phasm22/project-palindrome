import { expect, test } from "bun:test";
import {
  computeMaxSteps,
  isStuckOnEmptyStep,
  BASE_MAX_STEPS,
  EXTENDED_MAX_STEPS,
  EMPTY_STEP_STUCK_THRESHOLD,
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
