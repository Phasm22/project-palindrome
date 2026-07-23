import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { toExecutionResult } from "../../../src/types/execution";
import { ActionTool } from "../../../src/tools/ActionTool";
import { actionRegistry } from "../../../src/actions/registry";
import {
  isToolAuthorized,
  runWithToolAcl,
} from "../../../src/agent/tool-policy";
import { loadTools } from "../../../src/agent/tool-loader";
import type { ExecutionContext } from "../../../src/types/execution";

/**
 * RM-04 (Epic E1 — "One authoritative execution result").
 *
 * A domain action that RESOLVES with { success: false, ... } WITHOUT throwing
 * must surface as an ExecutionResult with `.error` set, so downstream code that
 * derives `success = !result.error` treats it as a failure. Conversely a
 * { success: true } action must NOT set `.error`.
 */
describe("toExecutionResult (RM-04 execution-result contract)", () => {
  it("promotes { success: false } into ExecutionResult.error (no throw path)", () => {
    const started = Date.now();
    const result = toExecutionResult(
      { success: false, message: "VM create failed: node offline" },
      started
    );

    expect(result.error).toBeDefined();
    expect(result.error).toBe("VM create failed: node offline");
    expect(result.success).toBe(false);
    // downstream derives success = !error → must be false
    expect(!result.error).toBe(false);
    // data is preserved for observability
    expect(result.data).toEqual({
      success: false,
      message: "VM create failed: node offline",
    });
  });

  it("prefers an explicit `error` string over `message`", () => {
    const result = toExecutionResult(
      { success: false, error: "explicit error", message: "fallback" },
      Date.now()
    );
    expect(result.error).toBe("explicit error");
  });

  it("falls back to a generic message when neither error nor message is a string", () => {
    const result = toExecutionResult({ success: false }, Date.now());
    expect(result.error).toBe("Action reported failure");
    expect(result.success).toBe(false);
  });

  it("does NOT set .error for a { success: true } action", () => {
    const result = toExecutionResult(
      { success: true, vmId: 123, message: "created" },
      Date.now()
    );
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(!result.error).toBe(true);
    expect(result.data).toEqual({ success: true, vmId: 123, message: "created" });
  });

  it("treats a result without a success field as success (no .error)", () => {
    const result = toExecutionResult({ vmId: 123 }, Date.now());
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it("always records durationMs", () => {
    const result = toExecutionResult({ success: true }, Date.now());
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("ActionTool.execute — failed action does not report success (RM-04)", () => {
  const context: ExecutionContext = { toolName: "action", startedAt: Date.now() };

  beforeAll(() => {
    // Register fake actions used only by these tests. The registry is a
    // singleton and throws on duplicate names, so guard each registration.
    if (!actionRegistry.get("test.fake_failing_action")) {
      actionRegistry.register({
        name: "test.fake_failing_action",
        description: "Fake action that RESOLVES with success:false (no throw)",
        schema: z.object({}).passthrough(),
        execute: async () => ({
          success: false,
          message: "simulated action failure",
        }),
      });
    }
    if (!actionRegistry.get("test.fake_succeeding_action")) {
      actionRegistry.register({
        name: "test.fake_succeeding_action",
        description: "Fake action that RESOLVES with success:true",
        schema: z.object({}).passthrough(),
        execute: async () => ({ success: true, detail: "ok" }),
      });
    }
  });

  it("sets ExecutionResult.error when action resolves { success: false }", async () => {
    const tool = new ActionTool();
    const result = await tool.execute(
      { action: "test.fake_failing_action", params: {} },
      context
    );

    expect(result.error).toBeDefined();
    expect(result.error).toBe("simulated action failure");
    expect(result.success).toBe(false);
    // downstream: success = !result.error → false (the bug this fixes)
    expect(!result.error).toBe(false);
    // data still carried through
    expect(result.data).toMatchObject({ success: false });
  });

  it("does NOT set ExecutionResult.error when action resolves { success: true }", async () => {
    const tool = new ActionTool();
    const result = await tool.execute(
      { action: "test.fake_succeeding_action", params: {} },
      context
    );

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(!result.error).toBe(true);
    expect(result.data).toMatchObject({ success: true, detail: "ok" });
  });
});

describe("ActionTool.execute — per-action ACL enforcement (RM-06)", () => {
  const context: ExecutionContext = { toolName: "action", startedAt: Date.now() };
  let executionCount = 0;

  beforeAll(() => {
    if (!actionRegistry.get("test.fake_admin_action")) {
      actionRegistry.register({
        name: "test.fake_admin_action",
        description: "Fake admin-only action",
        schema: z.object({}).passthrough(),
        acl: ["admin"],
        risk: "high",
        requiresConfirmation: false,
        execute: async () => {
          executionCount++;
          return { success: true };
        },
      });
    }
  });

  it("denies an ops caller before the admin-only action executes", async () => {
    executionCount = 0;
    const tool = new ActionTool();
    const result = await runWithToolAcl("ops", () =>
      tool.execute(
        { action: "test.fake_admin_action", params: {} },
        context
      )
    );

    expect(result.error).toBe(
      "ACL group ops is not authorized to run test.fake_admin_action"
    );
    expect(result.success).toBe(false);
    expect(executionCount).toBe(0);
  });

  it("enforces the registered action ACL through the loaded generic tool policy", () => {
    const tool = loadTools().find((candidate) => candidate.metadata.name === "action");
    expect(tool).toBeDefined();

    expect(
      isToolAuthorized(
        tool!,
        { userId: "ops-user", aclGroup: "ops" },
        { action: "compute.destroy_vm", params: { name: "test-vm" } }
      )
    ).toBe(false);
    expect(
      isToolAuthorized(
        tool!,
        { userId: "admin-user", aclGroup: "admin" },
        { action: "compute.destroy_vm", params: { name: "test-vm" } }
      )
    ).toBe(true);
  });

  it("allows an admin caller to execute the admin-only action", async () => {
    executionCount = 0;
    const tool = new ActionTool();
    const result = await runWithToolAcl("admin", () =>
      tool.execute(
        { action: "test.fake_admin_action", params: {} },
        context
      )
    );

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(executionCount).toBe(1);
  });
});
