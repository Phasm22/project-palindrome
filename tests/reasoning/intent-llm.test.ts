import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mapLLMResultToIntentClassification,
  type IntentClassificationLLM,
} from "../../src/reasoning/intent-schema";
import { classifyAndRoute, classifyAndRouteWithLLM } from "../../src/reasoning/intent-router";
import { isLikelyCompositeQuery } from "../../src/reasoning/composite-query";

describe("mapLLMResultToIntentClassification", () => {
  it("maps full LLM result to IntentClassification with all fields", () => {
    const llm: IntentClassificationLLM = {
      intent: "ACTION",
      confidence: 0.9,
      risk: "WRITE_HIGH",
      domain: "compute",
      actionType: "create",
      missingSlots: ["target_node"],
      entities: {
        hosts: ["yang"],
        services: [],
        resourceIds: [],
      },
    };
    const out = mapLLMResultToIntentClassification(llm);
    expect(out.type).toBe("ACTION");
    expect(out.intent).toBe("ACTION");
    expect(out.confidence).toBe(0.9);
    expect(out.risk).toBe("WRITE_HIGH");
    expect(out.entities).toEqual({ hosts: ["yang"], services: [], resourceIds: [] });
    expect(out.scope).toEqual({});
    expect(out.operation.verbs).toEqual(["create"]);
    expect(out.operation.type).toBe("create");
    expect(out.missing).toEqual(["target_node"]);
    expect(out.metadata).toEqual({
      domain: "compute",
      actionType: "create",
      queryType: undefined,
    });
  });

  it("maps LLM result with composite=true to metadata", () => {
    const llm: IntentClassificationLLM = {
      intent: "QUERY",
      confidence: 0.9,
      risk: "READ",
      domain: "compute",
      queryType: "status",
      composite: true,
      missingSlots: [],
      entities: { hosts: ["yang"], services: [], resourceIds: [] },
    };
    const out = mapLLMResultToIntentClassification(llm);
    expect(out.metadata?.composite).toBe(true);
  });

  it("maps QUERY intent with queryType to metadata", () => {
    const llm: IntentClassificationLLM = {
      intent: "QUERY",
      confidence: 0.85,
      risk: "READ",
      domain: "metrics",
      queryType: "temperature",
      missingSlots: [],
      entities: { hosts: [], services: [], resourceIds: [] },
    };
    const out = mapLLMResultToIntentClassification(llm);
    expect(out.type).toBe("QUERY");
    expect(out.operation.verbs).toEqual([]);
    expect(out.operation.type).toBe("temperature");
    expect(out.metadata?.queryType).toBe("temperature");
    expect(out.metadata?.domain).toBe("metrics");
  });

  it("maps CLARIFICATION and preserves missingSlots as missing", () => {
    const llm: IntentClassificationLLM = {
      intent: "CLARIFICATION",
      confidence: 0.2,
      risk: "READ",
      missingSlots: ["intent"],
      entities: { hosts: [], services: [], resourceIds: [] },
    };
    const out = mapLLMResultToIntentClassification(llm);
    expect(out.type).toBe("CLARIFICATION");
    expect(out.missing).toEqual(["intent"]);
    expect(out.metadata).toBeUndefined();
  });
});

describe("classifyAndRouteWithLLM", () => {
  it("returns same shape as classifyAndRoute on fallback (LLM API unavailable)", async () => {
    const input = "what is the temperature";
    const syncResult = classifyAndRoute(input);
    const asyncResult = await classifyAndRouteWithLLM(input);
    expect(asyncResult.classification.type).toBe(syncResult.classification.type);
    expect(asyncResult.routing.route).toBe(syncResult.routing.route);
    expect(asyncResult.classification.entities).toEqual(syncResult.classification.entities);
    expect(asyncResult.classification.risk).toBe(syncResult.classification.risk);
  });

  it("bypasses clarification when input is clearly informational (sync path)", () => {
    const input = "what is the temperature on the nodes";
    const result = classifyAndRoute(input);
    expect(result.classification.type).toBe("QUERY");
    expect(result.routing.route).not.toBe("clarification");
  });
});

describe("isLikelyCompositeQuery", () => {
  it("returns true when classification has metadata.composite true", () => {
    expect(
      isLikelyCompositeQuery("list vms", {
        type: "QUERY",
        intent: "QUERY",
        confidence: 0.9,
        entities: {},
        scope: {},
        operation: { type: "list", verbs: [] },
        risk: "READ",
        missing: [],
        metadata: { composite: true },
      })
    ).toBe(true);
  });

  it("returns true for node filter + exposure", () => {
    expect(isLikelyCompositeQuery("VMs on yang exposed to internet")).toBe(true);
    expect(isLikelyCompositeQuery("which VMs in 172.16.0.0/22 and their exposure level")).toBe(true);
  });

  it("returns true for and their exposure/temperature", () => {
    expect(isLikelyCompositeQuery("list nodes and their exposure level")).toBe(true);
    expect(isLikelyCompositeQuery("VMs with their temperature and no agent")).toBe(true);
  });

  it("returns false for simple single-dimension query", () => {
    expect(isLikelyCompositeQuery("what is the temperature on yang")).toBe(false);
    expect(isLikelyCompositeQuery("list all vms")).toBe(false);
  });
});
