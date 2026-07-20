import { SSHTool } from "../src/tools/SSHTool";

test("SSHTool rejects unapproved commands", async () => {
  const tool = new SSHTool();
  const res = await tool.execute(
    { host: "172.16.0.1", command: "rm -rf /" },
    { toolName: "ssh_execute", startedAt: Date.now() }
  );

  expect(res.error).toBeDefined();
  expect(res.error).toContain("not approved");
});

test("SSHTool rejects unknown hosts", async () => {
  const tool = new SSHTool();
  const res = await tool.execute(
    { host: "999.999.999.999", command: "uptime" },
    { toolName: "ssh_execute", startedAt: Date.now() }
  );

  expect(res.error).toBeDefined();
  expect(res.error).toContain("not found");
  expect(res.error).toContain("Available hosts");
});

test("SSHTool validates parameters", async () => {
  const tool = new SSHTool();
  const res = await tool.execute(
    { host: "172.16.0.1" }, // missing command
    { toolName: "ssh_execute", startedAt: Date.now() }
  );

  expect(res.error).toBeDefined();
});

test("SSHTool accepts approved commands", async () => {
  const tool = new SSHTool();
  // This will fail at SSH connection (expected), but should pass validation
  const res = await tool.execute(
    { host: "172.16.0.1", command: "uptime" },
    { toolName: "ssh_execute", startedAt: Date.now() }
  );

  // Should either succeed (if SSH works) or fail with connection error, not validation error
  if (res.error) {
    // Connection/auth errors are OK - means validation passed
    expect(res.error).not.toContain("not approved");
    expect(res.error).not.toContain("not found");
  } else {
    expect(res.data).toBeDefined();
  }
}, { timeout: 15000 });
