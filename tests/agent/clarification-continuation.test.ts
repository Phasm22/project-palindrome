import { describe, expect, test } from "bun:test";
import { classifyAndRoute } from "../../src/reasoning/intent-router";
import {
  isLikelyClarificationFragment,
  resolveClarificationContinuationInput,
} from "../../src/agent/clarification-continuation";

describe("clarification continuation", () => {
  test("treats short slot answer as continuation in NEED_CLARIFICATION state", () => {
    const result = resolveClarificationContinuationInput({
      userInput: "yang",
      conversationState: "NEED_CLARIFICATION",
      conversationHistory: [
        { role: "user", content: "create a vm" },
        { role: "assistant", content: "What is the target environment for the VM?" },
      ],
    });

    expect(result.usedContinuation).toBe(true);
    expect(result.anchorUserInput).toBe("create a vm");
    expect(result.effectiveInput).toBe("create a vm on yang");
  });

  test("effective continuation input resolves intent instead of re-asking intent type", () => {
    const result = resolveClarificationContinuationInput({
      userInput: "yang",
      conversationState: "NEED_CLARIFICATION",
      conversationHistory: [
        { role: "user", content: "create a vm" },
        { role: "assistant", content: "What is the target environment for the VM?" },
      ],
    });

    const routed = classifyAndRoute(result.effectiveInput);
    expect(routed.classification.intent).toBe("ACTION");
    expect(routed.classification.missing).not.toContain("intent");
  });

  test("does not rewrite full follow-up questions", () => {
    const result = resolveClarificationContinuationInput({
      userInput: "what environment options do I have?",
      conversationState: "NEED_CLARIFICATION",
      conversationHistory: [
        { role: "user", content: "create a vm" },
        { role: "assistant", content: "What is the target environment for the VM?" },
      ],
    });

    expect(result.usedContinuation).toBe(false);
    expect(result.effectiveInput).toBe("what environment options do I have?");
  });

  test("uses latest non-fragment user request as anchor across multi-clarification turns", () => {
    const result = resolveClarificationContinuationInput({
      userInput: "ubuntu",
      conversationState: "NEED_CLARIFICATION",
      conversationHistory: [
        { role: "user", content: "create a vm" },
        { role: "assistant", content: "What is the target environment for the VM?" },
        { role: "user", content: "yang" },
        { role: "assistant", content: "What image should I use?" },
      ],
    });

    expect(result.usedContinuation).toBe(true);
    expect(result.anchorUserInput).toBe("create a vm");
    expect(result.effectiveInput).toBe("create a vm ubuntu");
  });

  test("fragment detector excludes clear action questions", () => {
    expect(isLikelyClarificationFragment("yang")).toBe(true);
    expect(isLikelyClarificationFragment("create a vm on yang")).toBe(false);
    expect(isLikelyClarificationFragment("what can you do?")).toBe(false);
  });
});
