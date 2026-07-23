import { afterEach, describe, expect, test } from "bun:test";
import {
  CLASSIFIER_FALLBACK_CONTRACT,
  classifyIntentWithLLM,
  getConfidenceThreshold,
} from "../../src/reasoning/intent-router";
import type { IntentClassification } from "../../src/reasoning/intent-classifier";

const originalApiKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
});

function queryClassification(method: "llm" | "jaccard"): IntentClassification {
  return {
    type: "QUERY",
    intent: "QUERY",
    confidence: 0.4,
    classificationMethod: method,
    entities: { hosts: [], services: [], resourceIds: [] },
    scope: {},
    operation: { verbs: [] },
    risk: "READ",
    missing: [],
    metadata: { domain: "compute" },
  };
}

describe("authoritative classifier and fallback contract", () => {
  test("fallback triggers are explicit and exclude low confidence", () => {
    expect(CLASSIFIER_FALLBACK_CONTRACT.authoritative).toBe("llm");
    expect(CLASSIFIER_FALLBACK_CONTRACT.triggers).toEqual([
      "missing_api_key",
      "classification_error",
    ]);
    expect(CLASSIFIER_FALLBACK_CONTRACT.triggersOnLowConfidence).toBe(false);
  });

  test("a missing API key selects the deterministic fallback", async () => {
    delete process.env.OPENAI_API_KEY;
    const result = await classifyIntentWithLLM("list all VMs");
    expect(result.classificationMethod).toBe("jaccard");
    expect(result.metadata?.domain).toBe("compute");
  });

  test("confidence thresholds are selected from separate signal profiles", () => {
    expect(getConfidenceThreshold(queryClassification("jaccard"))).toBe(0.3);
    expect(getConfidenceThreshold(queryClassification("llm"))).toBe(0.5);
  });
});

