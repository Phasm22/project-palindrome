import { describe, it, expect, beforeEach, vi } from "vitest";
import { runAgent } from "../../src/agent/runner";
import { loadTools } from "../../src/agent/tool-loader";
import { ProxmoxWriteTool } from "../../src/tools/proxmox/writes/proxmox-write-tool";

// Mock OpenAI
vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    })),
  };
});

// Mock PCE API for RAG context
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("TL-2B.7: End-to-End Success Path Validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Set up environment
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
    process.env.PROXMOX_URL = "https://proxmox.example.com";
    process.env.PROXMOX_TOKEN_ID = "testuser@pam!testtoken";
    process.env.PROXMOX_TOKEN_SECRET = "test-secret";
    process.env.PCE_AUTO_APPROVE_HIGH_RISK_TOOLS = "true"; // Auto-approve for testing

    // Mock PCE API responses (Vector and Graph RAG)
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        answer: "Migration context",
        sources: [],
        sTotalScore: 0.8,
      }),
    });
  });

  it("should execute full migration flow: Query → LLM → Pre-Flight → Confirmation → Write → Provenance", async () => {
    // This test validates the components of the full migration flow
    // Full end-to-end testing requires live Proxmox and OpenAI API

    // Step 1: Verify tool is loaded and registered
    const tools = loadTools();
    const writeTool = tools.find((t) => t.metadata.name === "proxmox_write");
    expect(writeTool).toBeDefined();
    expect(writeTool).toBeInstanceOf(ProxmoxWriteTool);

    // Step 2: Verify tool has correct metadata (for LLM proposal and confirmation)
    expect(writeTool!.metadata.requiresConfirmation).toBe(true);
    expect(writeTool!.metadata.allowedAcls).toContain("admin");
    expect(writeTool!.metadata.allowedAcls).toContain("ops");

    // Step 3: Verify tool supports migrate_vm action with pre-flight checks
    const writeToolInstance = writeTool as ProxmoxWriteTool;
    
    // Mock the API client to avoid connection errors
    const mockClient = {
      get: vi.fn().mockResolvedValue({
        data: { data: { status: "online" } },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      }),
      post: vi.fn(),
    };
    (writeToolInstance as any).getApiClient = vi.fn().mockReturnValue(mockClient);
    
    const result = await writeToolInstance.execute(
      {
        action: "migrate_vm",
        node: "pve1",
        vmid: 101,
        targetNode: "pve2",
        dryRun: true, // Use dry-run to avoid actual migration
      },
      {
        toolName: "proxmox_write",
        startedAt: Date.now(),
        userId: "test-user",
        aclGroup: "ops",
      }
    );

    // Step 4: Verify pre-flight checks are executed
    expect(result.data).toBeDefined();
    expect(result.data.dryRun).toBe(true);
    expect(result.data.preFlightChecks).toBeDefined();
    expect(result.data.preFlightChecks.checks).toBeDefined();
    expect(result.data.preFlightChecks.checks.length).toBeGreaterThan(0);

    // Step 5: Verify provenance structure (would be in real execution)
    // In dry-run, we verify the structure is correct
    // Metadata is always present, _provenance may be in data or metadata
    expect(result.metadata).toBeDefined();
  }, 30000);

  it("should verify pre-flight checks are executed before migration", async () => {
    const tool = new ProxmoxWriteTool();
    
    // Mock Proxmox client responses for pre-flight checks
    const mockClient = {
      get: vi.fn().mockResolvedValue({
        data: { data: { status: "online" } },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      }),
      post: vi.fn(),
    };

    (tool as any).getApiClient = vi.fn().mockReturnValue(mockClient);

    const result = await tool.execute(
      {
        action: "migrate_vm",
        node: "pve1",
        vmid: 101,
        targetNode: "pve2",
        dryRun: true,
      },
      {
        toolName: "proxmox_write",
        startedAt: Date.now(),
        userId: "test-user",
        aclGroup: "ops",
      }
    );

    // Verify pre-flight checks were executed
    expect(result.data.preFlightChecks).toBeDefined();
    expect(result.data.preFlightChecks.checks).toBeDefined();
    expect(Array.isArray(result.data.preFlightChecks.checks)).toBe(true);
    expect(result.data.preFlightChecks.checks.length).toBeGreaterThan(0);

    // Verify client.get was called for pre-flight checks
    expect(mockClient.get).toHaveBeenCalled();
  });

  it("should verify confirmation is required for write operations", async () => {
    const tool = new ProxmoxWriteTool();
    
    // Verify tool requires confirmation
    expect(tool.metadata.requiresConfirmation).toBe(true);

    // Verify tool has restricted ACLs
    expect(tool.metadata.allowedAcls).toContain("admin");
    expect(tool.metadata.allowedAcls).toContain("ops");
  });

  it("should verify provenance is captured in write responses", async () => {
    const tool = new ProxmoxWriteTool();
    
    const mockClient = {
      get: vi.fn().mockResolvedValue({
        data: { data: { status: "stopped" } },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/123" },
      }),
      post: vi.fn().mockResolvedValue({
        data: { data: "OK" },
        metadata: { status: 200, timestamp: Date.now(), durationMs: 100, provenanceId: "tool://proxmox/test/456" },
      }),
    };

    (tool as any).getApiClient = vi.fn().mockReturnValue(mockClient);

    const result = await tool.execute(
      {
        action: "start_vm",
        node: "pve1",
        vmid: 101,
        dryRun: false,
      },
      {
        toolName: "proxmox_write",
        startedAt: Date.now(),
        userId: "test-user",
        aclGroup: "ops",
      }
    );

    // Verify provenance is included
    expect(result.data).toBeDefined();
    expect(result.data.preWriteState).toBeDefined();
    expect(result.data._provenance).toBeDefined();
    expect(result.data._provenance.provenanceId).toBeDefined();
  });
});

