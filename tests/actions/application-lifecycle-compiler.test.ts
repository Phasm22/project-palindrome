import { describe, expect, test } from "bun:test";
import { compileApplicationLifecycle } from "../../src/actions/applications/lifecycle-compiler";
import { makeApplicationManifest } from "./fixtures/application-manifest";

describe("compileApplicationLifecycle", () => {
  test("compiles independent VM branches before publishing an application", () => {
    const manifest = makeApplicationManifest();
    const secondVm = structuredClone(manifest.applications[0]!.vms[0]!);
    secondVm.name = "stark-api";
    secondVm.node = "YANG";
    secondVm.assets = [];
    secondVm.services = ["docker"];
    manifest.applications[0]!.vms.push(secondVm);

    const plan = compileApplicationLifecycle(manifest);
    const publish = plan.steps.find((step) => step.kind === "publish-application");

    expect(plan.steps.filter((step) => step.kind === "create-vm")).toHaveLength(2);
    expect(publish).toBeDefined();
    expect(publish!.dependencies).toContain("stark:stark:firewall");
    expect(publish!.dependencies).toContain("stark:stark-api:firewall");
    expect(publish!.dependencies).toContain("stark:stark:dns");
    expect(publish!.dependencies).toContain("stark:stark-api:dns");
  });

  test("uses separate Terraform locks for different control planes", () => {
    const manifest = makeApplicationManifest();
    const secondVm = structuredClone(manifest.applications[0]!.vms[0]!);
    secondVm.name = "stark-api";
    secondVm.node = "yin";
    manifest.applications[0]!.vms.push(secondVm);

    const createSteps = compileApplicationLifecycle(manifest).steps.filter(
      (step) => step.kind === "create-vm"
    );

    expect(new Set(createSteps.map((step) => step.lockKey)).size).toBe(2);
  });

  test("serializes VM ID allocation across the yin/YANG cluster", () => {
    const manifest = makeApplicationManifest();
    manifest.applications[0]!.vms[0]!.node = "yin";
    const secondVm = structuredClone(manifest.applications[0]!.vms[0]!);
    secondVm.name = "stark-api";
    secondVm.node = "YANG";
    manifest.applications[0]!.vms.push(secondVm);

    const reserveSteps = compileApplicationLifecycle(manifest).steps.filter(
      (step) => step.kind === "reserve-vm"
    );
    const createSteps = compileApplicationLifecycle(manifest).steps.filter(
      (step) => step.kind === "create-vm"
    );
    expect(new Set(reserveSteps.map((step) => step.lockKey)).size).toBe(1);
    expect(new Set(createSteps.map((step) => step.lockKey)).size).toBe(1);
  });

  test("teardown unpublishes before destroying VMs", () => {
    const manifest = makeApplicationManifest({ operation: "destroy" });
    const plan = compileApplicationLifecycle(manifest);
    const unpublish = plan.steps.find((step) => step.kind === "unpublish-application")!;
    const destroy = plan.steps.find((step) => step.kind === "destroy-vm")!;
    const verify = plan.steps.find((step) => step.kind === "verify-removal")!;

    expect(destroy.dependencies).toEqual([unpublish.id]);
    expect(verify.dependencies).toEqual([destroy.id]);
    expect(unpublish.risk).toBe("DESTRUCTIVE");
  });
});
