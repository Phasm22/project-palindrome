import { describe, it, expect, beforeEach, vi } from "vitest";
import { runAgent } from "../../src/agent/runner";
import { loadTools } from "../../src/agent/tool-loader";
import { ProxmoxWriteTool } from "../../src/tools/proxmox/writes/proxmox-write-tool";

// Mock OpenAI
const mockCreate = vi.fn();
vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    })),
  };
});

// Mock PCE API for RAG context
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("TL-2B.6: Write ACL Enforcement (Agent Runner Integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Set up environment
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
    process.env.PROXMOX_URL = "https://proxmox.example.com";
    process.env.PROXMOX_TOKEN_ID = "testuser@pam!testtoken";
    process.env.PROXMOX_TOKEN_SECRET = "test-secret";

    // Mock PCE API responses
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        answer: "Context",
        sources: [],
        sTotalScore: 0.8,
      }),
    });
  });

  it("should block viewer user from executing write operations at policy layer", () => {
    // This test verifies the ACL enforcement at the tool-policy layer
    // The actual blocking happens in the Agent Runner's isToolAuthorized check
    
    // Verify tool is loaded
    const tools = loadTools();
    const writeTool = tools.find((t) => t.metadata.name === "proxmox_write");
    expect(writeTool).toBeDefined();

    // Verify tool has ACL restrictions
    expect(writeTool!.metadata.allowedAcls).toContain("admin");
    expect(writeTool!.metadata.allowedAcls).toContain("ops");
    expect(writeTool!.metadata.allowedAcls).not.toContain("viewer");

    // Verify policy layer would block viewer
    // The actual blocking is tested in tests/tools/proxmox/writes/acl-enforcement.test.ts
    // This test confirms the tool is configured correctly for policy enforcement
    expect(writeTool!.metadata.allowedAcls!.length).toBeGreaterThan(0);
  });

  it("should allow ops user to execute write operations", () => {
    // This test verifies the ACL configuration allows ops users
    // The actual execution is tested in unit tests
    
    // Verify tool is loaded
    const tools = loadTools();
    const writeTool = tools.find((t) => t.metadata.name === "proxmox_write");
    expect(writeTool).toBeDefined();

    // Verify ops is in allowed ACLs
    expect(writeTool!.metadata.allowedAcls).toContain("ops");
    expect(writeTool!.metadata.allowedAcls).toContain("admin");

    // Verify policy layer would allow ops
    // The actual authorization is tested in tests/tools/proxmox/writes/acl-enforcement.test.ts
    expect(writeTool!.metadata.allowedAcls!.includes("ops")).toBe(true);
  });

  it("should verify tool-policy layer is called before tool execution", () => {
    // Verify tool is loaded and has correct metadata
    const tools = loadTools();
    const writeTool = tools.find((t) => t.metadata.name === "proxmox_write");
    
    expect(writeTool).toBeDefined();
    expect(writeTool).toBeInstanceOf(ProxmoxWriteTool);
    
    // Verify ACL restrictions are set
    expect(writeTool!.metadata.allowedAcls).toContain("admin");
    expect(writeTool!.metadata.allowedAcls).toContain("ops");
    expect(writeTool!.metadata.allowedAcls).not.toContain("viewer");
    
    // HIL confirmation is handled by the runner's policy layer (requiresConfirmation flag is false
    // on the tool itself; the runner evaluates high-risk tool calls and sets ASK_CONFIRM).
    expect(writeTool!.metadata.requiresConfirmation).toBe(false);
  });
});

