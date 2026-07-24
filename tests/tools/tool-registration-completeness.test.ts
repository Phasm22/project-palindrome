import { describe, expect, test } from "bun:test";
import { loadTools } from "../../src/agent/tool-loader";
import { BaseTool } from "../../src/tools/BaseTool";

const EXPECTED_TOOL_NAMES = [
  "action",
  "application_lifecycle",
  "ask_missing",
  "create_incident_ticket",
  "infrastructure_diagnostic",
  "lookup_user_profile",
  "mcp_opnsense",
  "next_steps",
  "opnsense_readonly",
  "opnsense_safewrite",
  "pihole_readonly",
  "proxmox_readonly",
  "proxmox_write",
  "run_diagnostic_command",
  "ssh_execute",
  "summarize_observations",
  "twin_query",
] as const;

const SCHEMALESS_TOOL_NAMES = new Set([
  "create_incident_ticket",
  "lookup_user_profile",
  "run_diagnostic_command",
]);

// ToolMetadata currently permits these two legacy tools to omit allowedAcls.
// Keep the exceptions explicit so any new ACL-less registration fails.
const LEGACY_UNSCOPED_TOOL_NAMES = new Set([
  "mcp_opnsense",
  "ssh_execute",
]);

describe("tool registration completeness", () => {
  const tools = loadTools();

  test("loads the complete non-empty set of reachable tools", () => {
    expect(tools.length).toBeGreaterThan(0);

    const names = tools.map((tool) => tool.metadata.name);
    expect([...names].sort()).toEqual([...EXPECTED_TOOL_NAMES]);
  });

  test("gives every registered tool a complete executable contract", () => {
    for (const tool of tools) {
      expect(tool).toBeInstanceOf(BaseTool);
      expect(tool.metadata.name.trim().length).toBeGreaterThan(0);
      expect(tool.metadata.description.trim().length).toBeGreaterThan(0);
      expect(typeof tool.execute).toBe("function");

      if (LEGACY_UNSCOPED_TOOL_NAMES.has(tool.metadata.name)) {
        expect(tool.metadata.allowedAcls).toBeUndefined();
      } else {
        expect(Array.isArray(tool.metadata.allowedAcls)).toBe(true);
        expect(tool.metadata.allowedAcls?.length).toBeGreaterThan(0);
        for (const acl of tool.metadata.allowedAcls ?? []) {
          expect(acl.trim().length).toBeGreaterThan(0);
        }
      }

      if (SCHEMALESS_TOOL_NAMES.has(tool.metadata.name)) {
        expect(tool.getSchema).toBeUndefined();
      } else {
        expect(typeof tool.getSchema).toBe("function");
        const schema = tool.getSchema!();
        expect(schema.name).toBe(tool.metadata.name);
        expect(schema.description.trim().length).toBeGreaterThan(0);
        expect(schema.parameters.type).toBe("object");
        expect(schema.parameters.properties).toBeDefined();
      }
    }
  });

  test("does not register duplicate or ambiguous tool identities", () => {
    const names = tools.map((tool) => tool.metadata.name);
    const constructors = tools.map((tool) => tool.constructor.name);

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(constructors).size).toBe(constructors.length);
  });
});
