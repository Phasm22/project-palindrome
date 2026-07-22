import { describe, expect, test } from "bun:test";
import { isLikelyCompositeQuery } from "../../src/reasoning/composite-query";

describe("isLikelyCompositeQuery", () => {
  test("detects existing compute+exposure composite shapes (regression)", () => {
    expect(isLikelyCompositeQuery("VMs on yang and their exposure level")).toBe(true);
    expect(isLikelyCompositeQuery("list VMs in subnet 172.16.0.0/22 and their exposure")).toBe(true);
  });

  test("detects DNS + exposure/vm/node as composite", () => {
    expect(
      isLikelyCompositeQuery("which client generates the most DNS queries, and is that host exposed to the internet")
    ).toBe(true);
    expect(isLikelyCompositeQuery("top DNS clients and which VMs they map to")).toBe(true);
    expect(isLikelyCompositeQuery("DNS queries per node")).toBe(true);
  });

  test("does NOT mark a plain single-aggregate DNS question as composite", () => {
    // Single-tool-call aggregate questions (Pi-hole returns pre-aggregated
    // data in one call) must stay on the cheap default budget — this is the
    // whole point of not just raising MAX_STEPS for anything DNS-flavored.
    expect(isLikelyCompositeQuery("what are the top blocked domains today")).toBe(false);
    expect(isLikelyCompositeQuery("how many DNS queries came from 172.16.0.100 today")).toBe(false);
    expect(isLikelyCompositeQuery("is example.com currently blocked")).toBe(false);
    expect(isLikelyCompositeQuery("list the custom DNS records")).toBe(false);
  });

  test("returns false for empty or whitespace-only input", () => {
    expect(isLikelyCompositeQuery("")).toBe(false);
    expect(isLikelyCompositeQuery("   ")).toBe(false);
  });

  test("classification.metadata.composite=true short-circuits to true regardless of text", () => {
    expect(
      isLikelyCompositeQuery("hello", {
        type: "QUERY",
        intent: "QUERY",
        confidence: 0.9,
        entities: [],
        scope: "single",
        operation: "read",
        risk: "READ",
        missing: [],
        metadata: { composite: true },
      } as any)
    ).toBe(true);
  });
});
