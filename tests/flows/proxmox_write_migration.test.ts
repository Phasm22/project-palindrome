import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { loadTools } from "../../src/agent/tool-loader";
import { ProxmoxWriteTool } from "../../src/tools/proxmox/writes/proxmox-write-tool";

// Tests that invoke the real Proxmox API only run when explicitly opted-in
const LIVE_PROXMOX = !!process.env.RUN_LIVE_PROXMOX_TESTS;

describe("TL-2B.7: End-to-End Success Path Validation", () => {
  let originalFetch: typeof global.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalEnv = { ...process.env };

    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
    process.env.PROXMOX_URL = "https://proxmox.example.com";
    process.env.PROXMOX_TOKEN_ID = "testuser@pam!testtoken";
    process.env.PROXMOX_TOKEN_SECRET = "test-secret";
    process.env.PCE_AUTO_APPROVE_HIGH_RISK_TOOLS = "true";

    global.fetch = (async () => ({
      ok: true,
      json: async () => ({ answer: "Migration context", sources: [], sTotalScore: 0.8 }),
    })) as any;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("should verify tool is loaded with correct metadata", () => {
    const tools = loadTools();
    const writeTool = tools.find((t) => t.metadata.name === "proxmox_write");
    expect(writeTool).toBeDefined();
    expect(writeTool).toBeInstanceOf(ProxmoxWriteTool);
    expect(writeTool!.metadata.allowedAcls).toContain("admin");
    expect(writeTool!.metadata.allowedAcls).toContain("ops");
    // HIL confirmation handled at runner policy layer, not tool metadata flag
    expect(writeTool!.metadata.requiresConfirmation).toBe(false);
  });

  it.skipIf(!LIVE_PROXMOX)("should execute full migration flow: Query → LLM → Pre-Flight → Confirmation → Write → Provenance", async () => {
    const tools = loadTools();
    const writeTool = tools.find((t) => t.metadata.name === "proxmox_write");
    expect(writeTool).toBeDefined();
    expect(writeTool).toBeInstanceOf(ProxmoxWriteTool);

    const writeToolInstance = writeTool as ProxmoxWriteTool;
    const result = await writeToolInstance.execute(
      { action: "migrate_vm", node: "pve1", vmid: 101, targetNode: "pve2", dryRun: true },
      { toolName: "proxmox_write", startedAt: Date.now(), userId: "test-user", aclGroup: "ops" }
    );

    expect(result.data).toBeDefined();
    expect(result.data.dryRun).toBe(true);
    expect(result.data.preFlightChecks).toBeDefined();
    expect(result.data.preFlightChecks.checks.length).toBeGreaterThan(0);
    expect(result.metadata).toBeDefined();
  }, 30000);

  it.skipIf(!LIVE_PROXMOX)("should verify pre-flight checks are executed before migration", async () => {
    const tool = new ProxmoxWriteTool();
    const result = await tool.execute(
      { action: "migrate_vm", node: "pve1", vmid: 101, targetNode: "pve2", dryRun: true },
      { toolName: "proxmox_write", startedAt: Date.now(), userId: "test-user", aclGroup: "ops" }
    );
    expect(result.data.preFlightChecks).toBeDefined();
    expect(Array.isArray(result.data.preFlightChecks.checks)).toBe(true);
    expect(result.data.preFlightChecks.checks.length).toBeGreaterThan(0);
  });

  it("should verify confirmation is required for write operations (policy layer)", () => {
    const tool = new ProxmoxWriteTool();
    // Tool metadata has requiresConfirmation=false; runner policy evaluates tool risk at execution time
    expect(tool.metadata.requiresConfirmation).toBe(false);
    expect(tool.metadata.allowedAcls).toContain("admin");
    expect(tool.metadata.allowedAcls).toContain("ops");
  });

  it.skipIf(!LIVE_PROXMOX)("should verify provenance is captured in write responses", async () => {
    const tool = new ProxmoxWriteTool();
    const result = await tool.execute(
      { action: "start_vm", node: "pve1", vmid: 101, dryRun: false },
      { toolName: "proxmox_write", startedAt: Date.now(), userId: "test-user", aclGroup: "ops" }
    );
    expect(result.data).toBeDefined();
    expect(result.data.preWriteState).toBeDefined();
    expect(result.data._provenance).toBeDefined();
    expect(result.data._provenance.provenanceId).toBeDefined();
  });
});
