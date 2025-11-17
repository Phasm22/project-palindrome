import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TL-1C.3: Unified Tool Definition Generation
 * 
 * The final script must generate a single, unified tool definition schema 
 * (tool_definition_opnsense_unified.json) containing all 25+ read and write actions, 
 * with correct function signatures, descriptions, and the necessary ACL/HIL metadata 
 * (TL-1B.3 & TL-1B.4).
 */

describe("TL-1C.3: Unified Tool Definition Generation", () => {
  let unifiedSchema: any;

  // Load schema once for all tests
  try {
    const schemaPath = join(process.cwd(), "tool_definition_opnsense_unified.json");
    const schemaContent = readFileSync(schemaPath, "utf-8");
    unifiedSchema = JSON.parse(schemaContent);
  } catch (error) {
    // Schema might not exist yet, that's okay for some tests
    unifiedSchema = null;
  }

  test("should have unified schema file", () => {
    expect(unifiedSchema).not.toBeNull();
    expect(unifiedSchema).toBeDefined();
  });

  test("should contain all 25+ actions (read + write)", () => {
    if (!unifiedSchema) {
      console.log("Skipping: unified schema not found. Run: bun src/tools/opnsense/generate-unified-schema.ts");
      return;
    }

    expect(unifiedSchema.actionCount).toBeDefined();
    expect(unifiedSchema.actionCount.total).toBeGreaterThanOrEqual(25);
    expect(unifiedSchema.actions).toBeDefined();
    expect(unifiedSchema.actions.all).toBeDefined();
    expect(unifiedSchema.actions.all.length).toBeGreaterThanOrEqual(25);
  });

  test("should contain all read-only actions", () => {
    if (!unifiedSchema) {
      console.log("Skipping: unified schema not found");
      return;
    }

    expect(unifiedSchema.actions.read).toBeDefined();
    expect(unifiedSchema.actions.read.length).toBeGreaterThanOrEqual(20);
    
    // Verify key read actions
    expect(unifiedSchema.actions.read).toContain("firewall_rules_list");
    expect(unifiedSchema.actions.read).toContain("system_status");
    expect(unifiedSchema.actions.read).toContain("diagnostics_system_logs");
    expect(unifiedSchema.actions.read).toContain("interfaces_vlans_list");
  });

  test("should contain all write actions", () => {
    if (!unifiedSchema) {
      console.log("Skipping: unified schema not found");
      return;
    }

    expect(unifiedSchema.actions.write).toBeDefined();
    expect(unifiedSchema.actions.write.length).toBeGreaterThanOrEqual(5);
    
    // Verify key write actions
    expect(unifiedSchema.actions.write).toContain("create_disabled_alias");
    expect(unifiedSchema.actions.write).toContain("enable_rule_with_confirmation");
    expect(unifiedSchema.actions.write).toContain("update_description_field");
  });

  test("should have correct function signatures in parameters", () => {
    if (!unifiedSchema) {
      console.log("Skipping: unified schema not found");
      return;
    }

    expect(unifiedSchema.parameters).toBeDefined();
    expect(unifiedSchema.parameters.type).toBe("object");
    expect(unifiedSchema.parameters.properties).toBeDefined();
    expect(unifiedSchema.parameters.properties.action).toBeDefined();
    expect(unifiedSchema.parameters.properties.action.type).toBe("string");
    expect(unifiedSchema.parameters.properties.action.enum).toBeDefined();
    expect(Array.isArray(unifiedSchema.parameters.properties.action.enum)).toBe(true);
  });

  test("should have ACL metadata (TL-1B.4)", () => {
    if (!unifiedSchema) {
      console.log("Skipping: unified schema not found");
      return;
    }

    expect(unifiedSchema.metadata).toBeDefined();
    expect(unifiedSchema.metadata.allowedAcls).toBeDefined();
    expect(unifiedSchema.metadata.allowedAcls.read).toBeDefined();
    expect(unifiedSchema.metadata.allowedAcls.write).toBeDefined();
    
    // Verify read ACLs
    expect(Array.isArray(unifiedSchema.metadata.allowedAcls.read)).toBe(true);
    expect(unifiedSchema.metadata.allowedAcls.read.length).toBeGreaterThan(0);
    
    // Verify write ACLs
    expect(Array.isArray(unifiedSchema.metadata.allowedAcls.write)).toBe(true);
    expect(unifiedSchema.metadata.allowedAcls.write.length).toBeGreaterThan(0);
  });

  test("should have HIL metadata (TL-1B.3)", () => {
    if (!unifiedSchema) {
      console.log("Skipping: unified schema not found");
      return;
    }

    expect(unifiedSchema.metadata).toBeDefined();
    expect(unifiedSchema.metadata.requiresConfirmation).toBeDefined();
    expect(unifiedSchema.metadata.requiresConfirmation.read).toBe(false);
    expect(unifiedSchema.metadata.requiresConfirmation.write).toBe(true);
  });

  test("should have risk metadata", () => {
    if (!unifiedSchema) {
      console.log("Skipping: unified schema not found");
      return;
    }

    expect(unifiedSchema.metadata.risk).toBeDefined();
    expect(unifiedSchema.metadata.risk.read).toBeDefined();
    expect(unifiedSchema.metadata.risk.write).toBeDefined();
    
    // Verify risk levels
    expect(["low", "medium", "high"]).toContain(unifiedSchema.metadata.risk.read);
    expect(["low", "medium", "high"]).toContain(unifiedSchema.metadata.risk.write);
  });

  test("should have descriptions for all actions", () => {
    if (!unifiedSchema) {
      console.log("Skipping: unified schema not found");
      return;
    }

    expect(unifiedSchema.description).toBeDefined();
    expect(typeof unifiedSchema.description).toBe("string");
    expect(unifiedSchema.description.length).toBeGreaterThan(0);
  });

  test("should have examples", () => {
    if (!unifiedSchema) {
      console.log("Skipping: unified schema not found");
      return;
    }

    expect(unifiedSchema.examples).toBeDefined();
    expect(Array.isArray(unifiedSchema.examples)).toBe(true);
    expect(unifiedSchema.examples.length).toBeGreaterThan(0);
  });

  test("should have notes/documentation", () => {
    if (!unifiedSchema) {
      console.log("Skipping: unified schema not found");
      return;
    }

    expect(unifiedSchema.notes).toBeDefined();
    expect(Array.isArray(unifiedSchema.notes)).toBe(true);
    expect(unifiedSchema.notes.length).toBeGreaterThan(0);
  });

  test("should have version and generation timestamp", () => {
    if (!unifiedSchema) {
      console.log("Skipping: unified schema not found");
      return;
    }

    expect(unifiedSchema.version).toBeDefined();
    expect(unifiedSchema.generatedAt).toBeDefined();
    expect(typeof unifiedSchema.generatedAt).toBe("string");
    
    // Verify timestamp is valid ISO date
    const date = new Date(unifiedSchema.generatedAt);
    expect(date.toString()).not.toBe("Invalid Date");
  });

  test("should have dryRun parameter for write operations", () => {
    if (!unifiedSchema) {
      console.log("Skipping: unified schema not found");
      return;
    }

    expect(unifiedSchema.parameters.properties.dryRun).toBeDefined();
    expect(unifiedSchema.parameters.properties.dryRun.type).toBe("boolean");
    expect(unifiedSchema.parameters.properties.dryRun.default).toBe(false);
  });

  test("should have all required parameters for write actions", () => {
    if (!unifiedSchema) {
      console.log("Skipping: unified schema not found");
      return;
    }

    const props = unifiedSchema.parameters.properties;
    
    // Verify create_disabled_alias parameters
    expect(props.alias_name).toBeDefined();
    expect(props.alias_type).toBeDefined();
    expect(props.alias_content).toBeDefined();
    
    // Verify enable_rule_with_confirmation parameters
    expect(props.rule_uuid).toBeDefined();
    
    // Verify update_description_field parameters
    expect(props.target_type).toBeDefined();
    expect(props.target_uuid).toBeDefined();
    expect(props.description).toBeDefined();
  });
});

