import { expect, test } from "bun:test";
import { networkDomainGateAllows } from "../../src/agent/runner";
import { detectNetworkIntent } from "../../src/reasoning/detectNetworkIntent";

/**
 * Regression coverage for B-06's domain-gate routing gap: runAgent's twin-first network
 * reasoning chain used to be gated purely on classification.metadata.domain, so when the
 * (non-deterministic) LLM classifier tagged a network-shaped query with some other domain
 * (e.g. "general" — observed live for bare "what is enx000ec698587a?" lookups with no
 * "network interface" framing), detectNetworkIntent() was never even called and the whole
 * twin-first chain was skipped, falling through to the LLM which hallucinated an answer.
 *
 * networkDomainGateAllows() is the extracted, pure gate predicate; this is the seam runner.ts
 * has no other way to unit-test (classifyAndRouteWithLLM has no injection point), per the
 * project's "no live infra/LLM in unit tests" testing convention.
 */

test("passes through when domain is absent (existing behavior)", () => {
  expect(networkDomainGateAllows(undefined, null)).toBe(true);
});

test("passes through when domain is exactly network (existing behavior)", () => {
  expect(networkDomainGateAllows("network", null)).toBe(true);
});

test("still blocks a genuinely off-domain query with no detector match (gate not weakened)", () => {
  expect(networkDomainGateAllows("compute", null)).toBe(false);
  expect(networkDomainGateAllows("firewall", null)).toBe(false);
  expect(networkDomainGateAllows("general", null)).toBe(false);
});

test("lets a positive deterministic detector match through even when domain is general (the fix)", () => {
  expect(networkDomainGateAllows("general", { type: "interface_lookup", interfaceName: "enx000ec698587a" })).toBe(true);
});

test("lets a positive deterministic detector match through regardless of the specific off-domain value", () => {
  expect(networkDomainGateAllows("compute", { type: "interface_lookup", interfaceName: "enx000ec698587a" })).toBe(true);
});

test("end-to-end: bare MAC-style interface lookup gate allows through even under a wrong domain guess", () => {
  const query = "what is enx000ec698587a?";
  const match = detectNetworkIntent(query);
  expect(match).toEqual({ type: "interface_lookup", interfaceName: "enx000ec698587a" });
  // Regardless of which domain the LLM classifier happened to assign this query:
  expect(networkDomainGateAllows("general", match)).toBe(true);
  expect(networkDomainGateAllows("network", match)).toBe(true);
  expect(networkDomainGateAllows(undefined, match)).toBe(true);
});

test("end-to-end: a genuinely off-domain query with no MAC/network shape stays blocked", () => {
  const query = "install docker on yang";
  const match = detectNetworkIntent(query);
  expect(match).toBeNull();
  expect(networkDomainGateAllows("compute", match)).toBe(false);
});
