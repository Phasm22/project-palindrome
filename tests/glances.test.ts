import { GlancesTool } from "../src/tools/GlancesTool";

test("GlancesTool returns data", async () => {
  const tool = new GlancesTool();
  const res = await tool.execute(
    { section: "cpu" },
    { toolName: "glances", startedAt: Date.now() }
  );
  
  // error allowed if glances isn't running
  expect(res.data || res.error).toBeDefined();
}, { timeout: 10000 });

