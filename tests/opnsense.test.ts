import { OpnsenseTool } from "../src/tools/OpnsenseTool";

test("OpnsenseTool rejects invalid actions", async () => {
  const tool = new OpnsenseTool();
  const res = await tool.execute(
    { action: "create_rule" as any },
    { toolName: "opnsense_manage", startedAt: Date.now() }
  );

  // Zod validation will reject invalid enum values before write check
  expect(res.error).toBeDefined();
  expect(res.error).toContain("Invalid");
});

test("OpnsenseTool validates action parameter", async () => {
  const tool = new OpnsenseTool();
  const res = await tool.execute(
    { action: "invalid_action" },
    { toolName: "opnsense_manage", startedAt: Date.now() }
  );

  expect(res.error).toBeDefined();
});

test("OpnsenseTool returns data or error for valid read actions", async () => {
  const tool = new OpnsenseTool();
  
  // Test system_status (may fail if OPNsense not accessible, but should return error, not crash)
  const res = await tool.execute(
    { action: "system_status" },
    { toolName: "opnsense_manage", startedAt: Date.now() }
  );

  // Should have either data or error, and duration
  expect(res.data || res.error).toBeDefined();
  if (res.durationMs !== undefined) {
    expect(typeof res.durationMs).toBe("number");
  }
}, { timeout: 10000 });

