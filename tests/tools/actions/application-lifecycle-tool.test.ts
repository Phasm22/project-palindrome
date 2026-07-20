import { describe, expect, test } from "bun:test";
import { ApplicationLifecycleTool } from "../../../src/tools/actions/ApplicationLifecycleTool";
import { makeApplicationManifest } from "../../actions/fixtures/application-manifest";

describe("ApplicationLifecycleTool", () => {
  test("is confirmation-gated and exposes a strict manifest schema", () => {
    const tool = new ApplicationLifecycleTool();
    const schema = tool.getSchema();

    expect(tool.metadata.risk).toBe("high");
    expect(tool.metadata.requiresConfirmation).toBe(true);
    expect(schema.parameters.additionalProperties).toBe(false);
    expect(schema.parameters.required).toContain("applications");
  });

  test("keeps every nested object compatible with strict function calling", () => {
    const parameters = new ApplicationLifecycleTool().getSchema().parameters;
    const violations: string[] = [];

    const inspect = (schema: unknown, path: string): void => {
      if (!schema || typeof schema !== "object") return;
      const value = schema as Record<string, unknown>;
      if (value.type === "object") {
        if (value.additionalProperties !== false) {
          violations.push(`${path} allows additional properties`);
        }
        const properties = (value.properties ?? {}) as Record<string, unknown>;
        const required = new Set((value.required ?? []) as string[]);
        for (const key of Object.keys(properties)) {
          if (!required.has(key)) violations.push(`${path}.${key} is optional`);
        }
      }
      for (const [key, child] of Object.entries(value)) {
        inspect(child, `${path}.${key}`);
      }
    };

    inspect(parameters, "parameters");
    expect(violations).toEqual([]);
  });

  test("rejects malformed manifests before any lifecycle work", async () => {
    const tool = new ApplicationLifecycleTool();
    const result = await tool.execute(
      { schemaVersion: "1", operation: "deploy" },
      { toolName: tool.metadata.name, startedAt: Date.now() }
    );

    expect(result.error).toContain("Invalid application manifest");
  });

  test("returns a complete non-mutating plan for dry-run manifests", async () => {
    const tool = new ApplicationLifecycleTool();
    const result = await tool.execute(
      makeApplicationManifest({ dryRun: true }),
      { toolName: tool.metadata.name, startedAt: Date.now() }
    );

    expect(result.error).toBeUndefined();
    expect(result.data?.dryRun).toBe(true);
    expect(result.data?.plan.steps.length).toBeGreaterThan(0);
  });
});
