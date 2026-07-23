import { describe, expect, test } from "bun:test";
import { destroyVm, DestroyVmSchema } from "../../src/actions/compute/destroy-vm";

/**
 * H-05 regression (docs/tests/fuzz-campaign-2026-07-21.md): a Cypher/prompt-
 * injection-flavored "VM name" must be rejected before destroyVm() ever
 * touches the digital twin or Terraform, rather than being silently
 * resolved to an unrelated real VM by a fuzzy name lookup downstream.
 *
 * These cases are expected to short-circuit before any TwinQueryService or
 * Terraform interaction, so they're safe to run without live infra — if
 * that assumption ever breaks, these tests will hang/fail loudly rather
 * than silently touching real infrastructure.
 */
describe("destroyVm name plausibility guard", () => {
  test("rejects a Cypher-injection-flavored name outright", async () => {
    const params = DestroyVmSchema.parse({ name: "' MATCH (n) DETACH DELETE n //" });
    const result = await destroyVm(params);
    expect(result.success).toBe(false);
    expect(result.message).toContain("does not look like a valid VM name");
  });

  test("rejects a degenerately short name", async () => {
    const params = DestroyVmSchema.parse({ name: "n" });
    const result = await destroyVm(params);
    expect(result.success).toBe(false);
    expect(result.message).toContain("does not look like a valid VM name");
  });

  test("rejects a multi-word 'sentence' where a single VM name is expected", async () => {
    const params = DestroyVmSchema.parse({ name: "the windows vm please" });
    const result = await destroyVm(params);
    expect(result.success).toBe(false);
    expect(result.message).toContain("does not look like a valid VM name");
  });
});
