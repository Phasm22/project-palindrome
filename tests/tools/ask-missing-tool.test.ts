import { describe, expect, test } from "bun:test";
import { AskMissingTool } from "../../src/tools/AskMissingTool";
import type { ExecutionContext } from "../../src/types";

function makeContext(): ExecutionContext {
  return { toolName: "ask_missing", startedAt: Date.now() };
}

describe("AskMissingTool", () => {
  test("asks about intent generically without leaking parameter names", async () => {
    const tool = new AskMissingTool();
    const result = await tool.execute({ missing: ["intent"] }, makeContext());
    expect(result.error).toBeUndefined();
    expect(result.data?.question).toContain("observe status");
  });

  test("maps 'fromId' to a plain-English question instead of echoing the raw slot name", async () => {
    // Regression: previously fell through to the LLM formatter, which just
    // echoed the raw field name back — "What is the fromId for the asset in
    // question?" — see fuzz-campaign-2026-07-21.md finding C-10.
    const tool = new AskMissingTool();
    const result = await tool.execute({ missing: ["fromId"] }, makeContext());
    expect(result.error).toBeUndefined();
    expect(result.data?.question).not.toContain("fromId");
    expect(result.data?.question).toContain("VM, node, or subnet");
  });

  test("maps 'chain' to a plain-English network/firewall question", async () => {
    const tool = new AskMissingTool();
    const result = await tool.execute({ missing: ["chain"] }, makeContext());
    expect(result.error).toBeUndefined();
    expect(result.data?.question).toContain("interface");
  });

  test("maps 'subnet' to a plain-English subnet/CIDR question", async () => {
    const tool = new AskMissingTool();
    const result = await tool.execute({ missing: ["subnet"] }, makeContext());
    expect(result.error).toBeUndefined();
    expect(result.data?.question).toContain("subnet");
  });

  test("maps 'alias' to a plain-English firewall alias question", async () => {
    const tool = new AskMissingTool();
    const result = await tool.execute({ missing: ["alias"] }, makeContext());
    expect(result.error).toBeUndefined();
    expect(result.data?.question).toContain("alias");
  });

  test("still asks for the target environment when node/host is missing", async () => {
    const tool = new AskMissingTool();
    const result = await tool.execute({ missing: ["node"] }, makeContext());
    expect(result.error).toBeUndefined();
    expect(result.data?.question).toContain("target environment");
  });
});
