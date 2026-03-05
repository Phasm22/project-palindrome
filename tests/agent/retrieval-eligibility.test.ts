import { describe, it, expect } from "bun:test";
import { getRetrievalEligibility } from "../../src/agent/retrieval-eligibility";

const baseParams = {
  isTrivialQuery: false,
  isActionIntent: false,
  isRealTimeMetricQuery: false,
  isMetaIdentityQuery: false,
};

describe("getRetrievalEligibility", () => {
  it("returns eligible: true for QUERY + network domain when isCompositeQuery is true", () => {
    const result = getRetrievalEligibility({
      ...baseParams,
      intent: "QUERY",
      domain: "network",
      isCompositeQuery: true,
    });
    expect(result.eligible).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("returns eligible: false with tool_first_domain for QUERY + network when isCompositeQuery is false", () => {
    const result = getRetrievalEligibility({
      ...baseParams,
      intent: "QUERY",
      domain: "network",
      isCompositeQuery: false,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("tool_first_domain");
  });

  it("returns eligible: true for QUERY + compute domain when isCompositeQuery is true", () => {
    const result = getRetrievalEligibility({
      ...baseParams,
      intent: "QUERY",
      domain: "compute",
      isCompositeQuery: true,
    });
    expect(result.eligible).toBe(true);
  });

  it("returns eligible: false with tool_first_domain for QUERY + firewall when isCompositeQuery is undefined", () => {
    const result = getRetrievalEligibility({
      ...baseParams,
      intent: "QUERY",
      domain: "firewall",
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("tool_first_domain");
  });
});
