import { test, expect } from "bun:test";
import { buildAgentState } from "../../src/agent/state";

test("buildAgentState populates the post-classification envelope and defaults ragPayload to null", () => {
  const state = buildAgentState({
    originalUserInput: "create a vm on yang",
    effectiveUserInput: "create a vm on yang",
    sessionId: "state-session",
    startTime: 123,
    session: { userId: "user-1", aclGroup: "admin" },
    options: { sessionId: "state-session" },
    classification: {
      type: "ACTION",
      intent: "ACTION",
      confidence: 0.91,
      metadata: { domain: "compute" },
      entities: { hosts: ["yang"], services: [] },
      missing: [],
      risk: "READ",
    } as any,
    routing: {
      route: "direct_handler",
      confidence: 0.91,
    } as any,
    conversationPlan: {
      decision: "EXECUTE",
      nextState: "FOLLOWUP",
      shouldExecute: true,
      responseMode: "ASSISTIVE",
    } as any,
    confirmation: {
      confirmed: false,
      cancelled: false,
    } as any,
    clarificationContinuation: {
      usedContinuation: false,
      effectiveInput: "create a vm on yang",
      anchorUserInput: null,
    } as any,
    tools: [],
    contextUpdate: { activeHost: "yang" },
    finalContextUpdate: { activeHost: "yang" },
    postExecutionState: "FOLLOWUP",
    responseMode: "ASSISTIVE",
  });

  expect(state.originalUserInput).toBe("create a vm on yang");
  expect(state.effectiveUserInput).toBe("create a vm on yang");
  expect(state.contextUpdate.activeHost).toBe("yang");
  expect(state.finalContextUpdate.activeHost).toBe("yang");
  expect(state.responseMode).toBe("ASSISTIVE");
  expect(state.ragPayload).toBeNull();
});
