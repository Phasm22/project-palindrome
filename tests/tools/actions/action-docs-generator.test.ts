import { describe, it, expect } from "vitest";
import { actionRegistry } from "../../../src/actions/registry";
import { generateActionParamsDoc } from "../../../src/actions/action-docs-generator";

describe("generateActionParamsDoc", () => {
  it("returns a non-empty string", () => {
    const actions = actionRegistry.list();
    const doc = generateActionParamsDoc(actions);
    expect(typeof doc).toBe("string");
    expect(doc.length).toBeGreaterThan(0);
  });

  it("starts with 'Action parameters as an object.'", () => {
    const doc = generateActionParamsDoc(actionRegistry.list());
    expect(doc.startsWith("Action parameters as an object.")).toBe(true);
  });

  it("ends with 'Must be an object.'", () => {
    const doc = generateActionParamsDoc(actionRegistry.list());
    expect(doc.endsWith("Must be an object.")).toBe(true);
  });

  it("includes each registered action name", () => {
    const actions = actionRegistry.list();
    const doc = generateActionParamsDoc(actions);
    for (const action of actions) {
      expect(doc).toContain(`For ${action.name}:`);
    }
  });

  it("includes field descriptions from Zod schema annotations", () => {
    const doc = generateActionParamsDoc(actionRegistry.list());
    // Spot-check descriptions on required/plain fields (not wrapped in ZodDefault).
    // ZodDefault-wrapped fields expose the description on the wrapper, which
    // zodToJsonSchemaProperty currently propagates from the inner type only —
    // so required string/number fields without .default() are the reliable check.
    expect(doc).toContain("Proxmox node name");        // compute.create_vm: node (ZodString)
    expect(doc).toContain("IPv4 address");             // network.create_dns_record: ip (ZodString)
    expect(doc).toContain("Proxmox VM ID");            // network.set_interface_vlan: vmid (ZodNumber)
    expect(doc).toContain("VLAN ID 1");                // network.set_interface_vlan: vlanId (ZodNumber)
    expect(doc).toContain("VM name to bootstrap");     // services.bootstrap: vmName (ZodString)
    expect(doc).toContain("VM name to install Docker"); // services.install_docker: vmName
  });

  it("marks optional fields with '(optional)'", () => {
    const doc = generateActionParamsDoc(actionRegistry.list());
    expect(doc).toContain("(optional)");
  });

  it("includes default values for fields with defaults", () => {
    const doc = generateActionParamsDoc(actionRegistry.list());
    // dryRun defaults to false in every schema
    expect(doc).toContain('(default: false)');
  });

  it("produces the same output on repeated calls (deterministic)", () => {
    const actions = actionRegistry.list();
    const doc1 = generateActionParamsDoc(actions);
    const doc2 = generateActionParamsDoc(actions);
    expect(doc1).toBe(doc2);
  });

  it("handles an empty action list gracefully", () => {
    const doc = generateActionParamsDoc([]);
    expect(doc).toBe("Action parameters as an object.  Must be an object.");
  });
});
