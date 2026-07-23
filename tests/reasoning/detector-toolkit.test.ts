import { describe, expect, test } from "bun:test";
import {
  extractNodeName,
  extractVmReference,
  hasLeadingDestructiveVerb,
  isActionRequest,
  KNOWN_NODE_NAMES,
} from "../../src/reasoning/detector-toolkit";
import { inferDomainFromToolRegistry } from "../../src/reasoning/classifier-registry";
import { detectComputeIntent } from "../../src/reasoning/compute-intents";
import { detectExposureIntent } from "../../src/reasoning/detectExposureIntent";

describe("shared detector toolkit", () => {
  test("extracts every supported VM-ID spelling through one parser", () => {
    expect(extractVmReference("show vm 104")?.numericId).toBe(104);
    expect(extractVmReference("show VM-ID 105")?.numericId).toBe(105);
    expect(extractVmReference("show vm106")?.numericId).toBe(106);
    expect(extractVmReference("show compute-vm:yin:107")?.canonicalId).toBe("compute-vm:yin:107");
  });

  test("VM-ID parsing rejects plausible numeric near-misses", () => {
    expect(extractVmReference("port 104 on vlan 20")).toBeNull();
    expect(extractVmReference("version 104")).toBeNull();
    expect(extractVmReference("the VM named test-vm-01")).toBeNull();
  });

  test("node resolution uses one deduplicated canonical set", () => {
    expect([...KNOWN_NODE_NAMES].filter((node) => node === "proxbig")).toHaveLength(1);
    expect(extractNodeName("list vms on proxbig", { allowKnownBare: true })).toBe("proxbig");
    expect(extractNodeName("the word proxbigger is not a node", { allowKnownBare: true })).toBeNull();
  });

  test("action hardening accepts leading commands but rejects buried or question-form verbs", () => {
    expect(hasLeadingDestructiveVerb("please go ahead and delete vm 104")).toBe(true);
    expect(isActionRequest("destroy vm 104")).toBe(true);
    expect(isActionRequest("what would happen if I destroy vm 104?")).toBe(false);
    expect(isActionRequest("show network state before I configure it later")).toBe(false);
  });

  test("query detectors share the action exclusion guard", () => {
    expect(detectComputeIntent("destroy vm 104")).toBeNull();
    expect(detectExposureIntent("delete vm 104 exposed to the internet")).toBeNull();
  });

  test("DNS triggers do not match a plausible lexical near-miss", () => {
    expect(inferDomainFromToolRegistry("show DNS records")).toBe("dns");
    expect(inferDomainFromToolRegistry("show dense records")).toBe("general");
  });
});
