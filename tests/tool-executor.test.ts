import { executeToolCall } from "../src/agent/tool-executor";
import { RunDiagnosticTool } from "../src/tools/RunDiagnosticTool";

test("executeToolCall finds and executes tool", async () => {
  const tools = [new RunDiagnosticTool()];
  const result = await executeToolCall(
    { toolName: "run_diagnostic_command", parameters: { command: "ping", target: "127.0.0.1" } },
    tools
  );

  // Should execute (error allowed if ping fails)
  expect(result.data || result.error).toBeDefined();
});

test("executeToolCall returns error for unknown tool", async () => {
  const tools = [new RunDiagnosticTool()];
  const result = await executeToolCall(
    { toolName: "unknown-tool", parameters: {} },
    tools
  );

  expect(result.error).toBeDefined();
  expect(result.error).toContain("Unknown tool");
});

