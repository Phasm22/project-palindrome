import { expect, test } from "bun:test";
import { parseTemplateCandidates, rankTemplateCandidates } from "../../src/actions/compute/create-vm";

test("parseTemplateCandidates keeps only template VMs", () => {
  const parsed = parseTemplateCandidates([
    { vmid: 8000, name: "ubuntu-2404-template", template: 1 },
    { vmid: 105, name: "app-vm", template: 0 },
    { vmid: "8001", name: "ubuntu-cloud-template", template: "true" },
    { vmid: 8010, name: "ignored-no-flag" },
  ]);

  expect(parsed).toEqual([
    { vmid: 8000, name: "ubuntu-2404-template" },
    { vmid: 8001, name: "ubuntu-cloud-template" },
  ]);
});

test("rankTemplateCandidates prefers explicit template ID", () => {
  const ranked = rankTemplateCandidates(
    [
      { vmid: 9000, name: "ubuntu-template" },
      { vmid: 8001, name: "cloud-template" },
      { vmid: 8000, name: "base-template" },
    ],
    9000
  );

  expect(ranked[0]?.vmid).toBe(9000);
});

test("rankTemplateCandidates prefers cloud/ubuntu naming when no explicit ID", () => {
  const ranked = rankTemplateCandidates([
    { vmid: 8002, name: "misc-template" },
    { vmid: 8003, name: "ubuntu-cloud-template" },
  ]);

  expect(ranked[0]?.vmid).toBe(8003);
});
