import { expect, test } from "bun:test";
import {
  findUnexpectedTerraformDeletes,
  getTerraformDeleteAddresses,
  normalizeDestroyVmIdentifiers,
  stripAnsi,
  terraformTargetWasDestroyed,
} from "../../src/actions/compute/destroy-vm";

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

test("findUnexpectedTerraformDeletes rejects deletes outside the requested VM", () => {
  const plan = {
    resource_changes: [
      {
        address: 'proxmox_virtual_environment_vm.lab_vms["stark"]',
        change: { actions: ["delete"] },
      },
      {
        address: 'proxmox_virtual_environment_vm.lab_vms["porttest"]',
        change: { actions: ["delete"] },
      },
      {
        address: "null_resource.ansible_inventory",
        change: { actions: ["delete"] },
      },
    ],
  };

  expect(getTerraformDeleteAddresses(plan)).toHaveLength(3);
  expect(
    findUnexpectedTerraformDeletes(plan, [
      'proxmox_virtual_environment_vm.lab_vms["stark"]',
    ])
  ).toEqual([
    'proxmox_virtual_environment_vm.lab_vms["porttest"]',
    "null_resource.ansible_inventory",
  ]);
});

test("terraformTargetWasDestroyed recognizes exact Terraform completion output", () => {
  const target = 'proxmox_virtual_environment_vm.lab_vms["stark"]';
  expect(terraformTargetWasDestroyed(`${target}: Destruction complete after 3s`, target)).toBe(true);
  expect(
    terraformTargetWasDestroyed(
      'proxmox_virtual_environment_vm.lab_vms["other"]: Destruction complete after 3s',
      target
    )
  ).toBe(false);
});

test("stripAnsi removes Terraform terminal color sequences", () => {
  expect(stripAnsi("\u001b[31mError:\u001b[0m certificate verify failed")).toBe(
    "Error: certificate verify failed"
  );
});
