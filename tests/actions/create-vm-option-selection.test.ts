import { expect, test } from "bun:test";
import {
  parseDatastoreCandidates,
  parseBridgeCandidates,
  selectAvailableOption,
} from "../../src/actions/compute/create-vm";

test("parseDatastoreCandidates keeps only active/enabled datastores", () => {
  const parsed = parseDatastoreCandidates([
    { storage: "local-lvm", enabled: 1, active: 1 },
    { storage: "local", enabled: 1, active: 1 },
    { storage: "offline-store", enabled: 0, active: 1 },
    { storage: "disabled-store", enabled: 1, active: 0 },
  ]);

  expect(parsed).toEqual(["local-lvm", "local"]);
});

test("parseBridgeCandidates keeps only active bridges", () => {
  const parsed = parseBridgeCandidates([
    { iface: "vmbr0", type: "bridge", active: 1 },
    { iface: "enp1s0", type: "eth", active: 1 },
    { iface: "vmbr2", type: "bridge", active: 0 },
  ]);

  expect(parsed).toEqual(["vmbr0"]);
});

test("selectAvailableOption picks preferred when present", () => {
  const selected = selectAvailableOption({
    optionName: "bridge",
    preferredValue: "vmbr2",
    availableValues: ["vmbr0", "vmbr2"],
    priorityValues: ["vmbr0", "vmbr1", "vmbr2"],
    nodeName: "YANG",
  });

  expect(selected.value).toBe("vmbr2");
  expect(selected.warning).toBeUndefined();
});

test("selectAvailableOption falls back with warning when preferred missing", () => {
  const selected = selectAvailableOption({
    optionName: "datastore",
    preferredValue: "snippets",
    availableValues: ["local-lvm", "local"],
    priorityValues: ["local-lvm", "local", "snippets"],
    nodeName: "yin",
  });

  expect(selected.value).toBe("local-lvm");
  expect(selected.warning).toContain("not available");
});
