import { describe, expect, test } from "bun:test";
import { executeApplicationLifecycle } from "../../src/actions/applications/application-lifecycle-action";
import { makeApplicationManifest } from "./fixtures/application-manifest";

describe("executeApplicationLifecycle", () => {
  test("dry-run compiles the entire lifecycle without running handlers", async () => {
    const manifest = makeApplicationManifest({ dryRun: true });
    const result = await executeApplicationLifecycle(manifest);

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.execution).toBeUndefined();
    expect(result.plan.steps.some((step) => step.kind === "create-vm")).toBe(true);
    expect(
      result.plan.steps.some((step) => step.kind === "publish-application")
    ).toBe(true);
  });

  test("plans multiple applications, images, and yin/YANG environments together", async () => {
    const yin = makeApplicationManifest({ dryRun: true });
    const yinApplication = yin.applications[0]!;
    yinApplication.name = "yin-gallery";
    yinApplication.domain = "yin-gallery.ops.prox";
    yinApplication.vms[0]!.name = "yin-gallery";
    yinApplication.vms[0]!.node = "yin";
    yinApplication.vms[0]!.assets[0]!.prompt =
      "A white Nissan Silvia S15 Spec-R in a bright alpine environment";

    const yangApplication = structuredClone(yinApplication);
    yangApplication.name = "yang-gallery";
    yangApplication.domain = "yang-gallery.ops.prox";
    yangApplication.vms[0]!.name = "yang-gallery";
    yangApplication.vms[0]!.node = "YANG";
    yangApplication.vms[0]!.assets[0]!.id = "night-hero";
    yangApplication.vms[0]!.assets[0]!.prompt =
      "A black Nissan Silvia S15 Spec-R in a rainy neon city environment";

    yin.applications.push(yangApplication);
    const result = await executeApplicationLifecycle(yin);

    expect(result.success).toBe(true);
    expect(result.plan.steps.filter((step) => step.kind === "create-vm")).toHaveLength(
      2
    );
    expect(
      result.plan.steps.filter((step) => step.kind === "deploy-assets")
    ).toHaveLength(2);
    expect(
      result.plan.steps.filter((step) => step.kind === "publish-application")
    ).toHaveLength(2);
    expect(
      result.plan.steps
        .filter((step) => step.kind === "reserve-vm")
        .every((step) => step.lockKey === "vm-allocation:yin-yang")
    ).toBe(true);
    expect(
      result.plan.steps
        .filter((step) => step.kind === "create-vm")
        .every((step) => step.lockKey === "terraform:yin-yang")
    ).toBe(true);
  });
});
