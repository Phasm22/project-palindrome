import { describe, expect, test } from "bun:test";
import { executeToolCall } from "../../src/agent/tool-executor";
import { BaseTool } from "../../src/tools/BaseTool";
import type { ExecutionContext, ExecutionResult } from "../../src/types";

class ThrowingTool extends BaseTool {
  constructor() {
    super({
      name: "throwing_tool",
      description: "A tool that throws instead of returning { error }.",
      categories: ["test"],
      allowedAcls: ["admin"],
      risk: "low",
    });
  }

  async execute(_params: Record<string, any>, _context: ExecutionContext): Promise<ExecutionResult> {
    throw new Error("boom: parameter required");
  }
}

class SyncThrowingTool extends BaseTool {
  constructor() {
    super({
      name: "sync_throwing_tool",
      description: "A tool whose execute() throws synchronously before returning a promise.",
      categories: ["test"],
      allowedAcls: ["admin"],
      risk: "low",
    });
  }

  // Intentionally not async — throws before any promise is created.
  execute(_params: Record<string, any>, _context: ExecutionContext): Promise<ExecutionResult> {
    throw new Error("sync boom");
  }
}

class HealthyTool extends BaseTool {
  constructor() {
    super({
      name: "healthy_tool",
      description: "A well-behaved tool.",
      categories: ["test"],
      allowedAcls: ["admin"],
      risk: "low",
    });
  }

  async execute(_params: Record<string, any>, _context: ExecutionContext): Promise<ExecutionResult> {
    return { data: { ok: true } };
  }
}

describe("executeToolCall", () => {
  test("converts a thrown error into a normal { error } result instead of rejecting", async () => {
    const tools = [new ThrowingTool()];
    const result = await executeToolCall({ toolName: "throwing_tool", parameters: {} }, tools);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("boom: parameter required");
  });

  test("converts a synchronous throw into a normal { error } result instead of rejecting", async () => {
    const tools = [new SyncThrowingTool()];
    const result = await executeToolCall({ toolName: "sync_throwing_tool", parameters: {} }, tools);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("sync boom");
  });

  test("still returns normal results for well-behaved tools", async () => {
    const tools = [new HealthyTool()];
    const result = await executeToolCall({ toolName: "healthy_tool", parameters: {} }, tools);
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual({ ok: true });
  });

  test("returns an error for unknown tools without throwing", async () => {
    const result = await executeToolCall({ toolName: "does_not_exist", parameters: {} }, []);
    expect(result.error).toBe("Unknown tool: does_not_exist");
  });
});
