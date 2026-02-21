import { expect, test } from "bun:test";
import {
  extractTerraformVmDestroyTargets,
  parseTerraformPlanSummary,
  sanitizeVmName,
} from "../../src/actions/compute/create-vm";

test("parseTerraformPlanSummary parses standard terraform plan footer", () => {
  const summary = parseTerraformPlanSummary(
    "Plan: 1 to add, 0 to change, 2 to destroy."
  );

  expect(summary).toEqual({ add: 1, change: 0, destroy: 2 });
});

test("parseTerraformPlanSummary returns zero for no-change plans", () => {
  const summary = parseTerraformPlanSummary("No changes. Your infrastructure matches the configuration.");
  expect(summary).toEqual({ add: 0, change: 0, destroy: 0 });
});

test("extractTerraformVmDestroyTargets detects VM destroy/replace actions", () => {
  const plan = `
  # proxmox_virtual_environment_vm.lab_vms["aha"] must be replaced
  # proxmox_virtual_environment_vm.lab_vms["bib"] will be destroyed
  # null_resource.ansible_inventory must be replaced
  `;

  const targets = extractTerraformVmDestroyTargets(plan);
  expect(targets.sort()).toEqual([
    'proxmox_virtual_environment_vm.lab_vms["aha"]',
    'proxmox_virtual_environment_vm.lab_vms["bib"]',
  ]);
});

test("extractTerraformVmDestroyTargets ignores non-VM destroys", () => {
  const plan = `
  # null_resource.ansible_inventory must be replaced
  # proxmox_virtual_environment_file.cloud_config["aha"] will be destroyed
  `;

  const targets = extractTerraformVmDestroyTargets(plan);
  expect(targets).toEqual([]);
});

test("sanitizeVmName preserves letters and normalizes separators", () => {
  expect(sanitizeVmName("sqeak")).toBe("sqeak");
  expect(sanitizeVmName("Ops Box_01")).toBe("ops-box-01");
});
