import { describe, expect, test } from "bun:test";
import {
  ApplicationManifestSchema,
  hashApplicationManifest,
} from "../../src/actions/applications/application-manifest";
import { makeApplicationManifest } from "./fixtures/application-manifest";

describe("ApplicationManifestSchema", () => {
  test("accepts a strict multi-system application description", () => {
    const result = ApplicationManifestSchema.safeParse(makeApplicationManifest());
    expect(result.success).toBe(true);
  });

  test("rejects duplicate VM names across applications", () => {
    const base = makeApplicationManifest();
    const duplicate = structuredClone(base.applications[0]!);
    duplicate.name = "stark-copy";
    duplicate.domain = "stark-copy.ops.prox";

    const result = ApplicationManifestSchema.safeParse({
      ...base,
      applications: [base.applications[0], duplicate],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("Duplicate VM name"))).toBe(true);
  });

  test("requires generated assets to have prompts", () => {
    const manifest = makeApplicationManifest();
    manifest.applications[0]!.vms[0]!.assets[0]!.prompt = null;

    const result = ApplicationManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  test("requires protected applications to select an identity provider", () => {
    const manifest = makeApplicationManifest();
    manifest.applications[0]!.identity.provider = "none";

    const result = ApplicationManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  test("hash is stable and changes with desired state", () => {
    const first = makeApplicationManifest();
    const second = structuredClone(first);
    expect(hashApplicationManifest(first)).toBe(hashApplicationManifest(second));

    second.applications[0]!.vms[0]!.memory = 8192;
    expect(hashApplicationManifest(first)).not.toBe(hashApplicationManifest(second));
  });
});
