import { BaseTool } from "../src/tools/BaseTool";
import type { ExecutionResult, ExecutionContext } from "../src/types/execution";

class DummyTool extends BaseTool {
  execute(_params: Record<string, any>, _context: ExecutionContext): Promise<ExecutionResult> {
    return Promise.resolve({ data: "ok" });
  }
}

test("BaseTool constructs metadata", () => {
  const tool = new DummyTool({ name: "dummy", description: "test" });
  expect(tool.metadata.name).toBe("dummy");
});

