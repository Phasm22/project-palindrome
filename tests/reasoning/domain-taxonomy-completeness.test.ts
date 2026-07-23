import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DOMAINS } from "../../src/reasoning/domain-taxonomy";
import {
  DOMAIN_CLARIFICATION_SUGGESTIONS,
  DOMAIN_CONSUMER_COVERAGE,
  type DomainConsumer,
} from "../../src/reasoning/domain-consumers";
import {
  getToolClassificationRegistry,
  inferDomainFromToolRegistry,
} from "../../src/reasoning/classifier-registry";
import { IntentClassificationSchema } from "../../src/reasoning/intent-schema";
import { QUERY_DOMAIN_HANDLERS } from "../../src/reasoning/intent-router";

const CONSUMERS: readonly DomainConsumer[] = [
  "llmSchema",
  "toolRegistration",
  "fallbackClassifier",
  "toolFirstRouting",
  "retrievalDomainMatch",
  "directQueryHandler",
  "twinFirstChain",
  "clarificationSuggestion",
  "compositeQueries",
];

describe("canonical domain taxonomy completeness", () => {
  const registry = getToolClassificationRegistry();

  test("the LLM schema derives exactly the canonical domains (including dns)", () => {
    const schemaDomains = IntentClassificationSchema.shape.domain.unwrap().options;
    expect(schemaDomains).toEqual([...DOMAINS]);
  });

  test("every known consumer has a supported entry or a reasoned opt-out", () => {
    expect(Object.keys(DOMAIN_CONSUMER_COVERAGE)).toEqual([...DOMAINS]);
    for (const domain of DOMAINS) {
      expect(Object.keys(DOMAIN_CONSUMER_COVERAGE[domain])).toEqual(CONSUMERS);
      for (const consumer of CONSUMERS) {
        const decision = DOMAIN_CONSUMER_COVERAGE[domain][consumer];
        expect(["supported", "opt_out"]).toContain(decision.status);
        if (decision.status === "opt_out") expect(decision.reason.length).toBeGreaterThan(10);
      }
    }
  });

  test("tool-owned consumers agree with loaded tool registrations", () => {
    for (const domain of DOMAINS) {
      const coverage = DOMAIN_CONSUMER_COVERAGE[domain];
      const registration = registry[domain];
      if (coverage.toolRegistration.status === "supported") {
        expect(registration.toolNames.length).toBeGreaterThan(0);
      }
      if (coverage.toolFirstRouting.status === "supported") {
        expect(registration.toolFirst).toBe(true);
      }
      if (coverage.retrievalDomainMatch.status === "supported") {
        expect(registration.retrievalKeywords.length).toBeGreaterThan(0);
      }
      if (coverage.compositeQueries.status === "supported") {
        expect(registration.compositeEligible).toBe(true);
      }
    }
  });

  test("fallback domain coverage is at least as complete as the primary schema", () => {
    for (const domain of DOMAINS) {
      const coverage = DOMAIN_CONSUMER_COVERAGE[domain].fallbackClassifier;
      if (coverage.status === "opt_out") continue;
      if (domain === "general") {
        expect(inferDomainFromToolRegistry("hello, how are you?")).toBe("general");
        continue;
      }
      expect(registry[domain].classificationExamples.length).toBeGreaterThan(0);
      for (const example of registry[domain].classificationExamples) {
        expect(inferDomainFromToolRegistry(example)).toBe(domain);
      }
    }
  });

  test("direct handlers, clarification prompts, and twin chains match reviewed coverage", () => {
    for (const domain of DOMAINS) {
      const coverage = DOMAIN_CONSUMER_COVERAGE[domain];
      expect(QUERY_DOMAIN_HANDLERS[domain] !== null).toBe(
        coverage.directQueryHandler.status === "supported"
      );
      expect(DOMAIN_CLARIFICATION_SUGGESTIONS[domain] !== null).toBe(
        coverage.clarificationSuggestion.status === "supported"
      );

      if (coverage.twinFirstChain.status === "supported") {
        const chainPath = resolve(import.meta.dir, `../../src/reasoning/chains/${domain}.ts`);
        expect(existsSync(chainPath)).toBe(true);
      }
    }
  });
});

