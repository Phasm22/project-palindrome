import { expect, test } from "bun:test";
import { normalizeDestroyVmIdentifiers } from "../../src/actions/compute/destroy-vm";

test("normalizeDestroyVmIdentifiers strips .prox for terraform and keeps DNS domain", () => {
  const normalized = normalizeDestroyVmIdentifiers("aha.prox");
  expect(normalized.infraName).toBe("aha");
  expect(normalized.dnsDomain).toBe("aha.prox");
});

test("normalizeDestroyVmIdentifiers adds .prox DNS suffix when missing", () => {
  const normalized = normalizeDestroyVmIdentifiers("aha");
  expect(normalized.infraName).toBe("aha");
  expect(normalized.dnsDomain).toBe("aha.prox");
});

test("normalizeDestroyVmIdentifiers trims trailing dot", () => {
  const normalized = normalizeDestroyVmIdentifiers("aha.prox.");
  expect(normalized.infraName).toBe("aha");
  expect(normalized.dnsDomain).toBe("aha.prox");
});
