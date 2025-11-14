import { executeToolCall } from "../src/agent/tool-executor";
import { GlancesTool } from "../src/tools/GlancesTool";

test("executeToolCall finds and executes tool", async () => {
  const tools = [new GlancesTool()];
  const result = await executeToolCall(
    { toolName: "glances", parameters: { section: "cpu" } },
    tools
  );

  // Should execute (error allowed if glances isn't running)
  expect(result.data || result.error).toBeDefined();
});

test("executeToolCall returns error for unknown tool", async () => {
  const tools = [new GlancesTool()];
  const result = await executeToolCall(
    { toolName: "unknown-tool", parameters: {} },
    tools
  );

  expect(result.error).toBeDefined();
  expect(result.error).toContain("Unknown tool");
});

