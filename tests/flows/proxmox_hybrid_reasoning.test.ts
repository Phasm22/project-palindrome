import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runAgent } from "../../src/agent/runner";
import { loadTools } from "../../src/agent/tool-loader";
import { ProxmoxReadOnlyTool } from "../../src/tools/proxmox/readonly";
import { generateAllProxmoxDocuments, extractProxmoxGraphEntities } from "../../src/tools/proxmox/readonly";
import { readFileSync } from "fs";
import { join } from "path";

// Load .env file if it exists (Bun auto-loads .env, but ensure it's loaded for tests).
// Only fill in keys that are genuinely absent - `!process.env[key]` is also true for
// an intentionally-empty value (e.g. CI sets PROXMOX_URL='' so live-API tests skip),
// and that falsy check silently overwrote it with .env's real value, leaking a real
// key/URL into every test that ran afterward in the same bun test process.
try {
  const envFile = readFileSync(join(process.cwd(), ".env"), "utf-8");
  envFile.split("\n").forEach((line) => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  });
} catch (e) {
  // .env file doesn't exist or can't be read, that's okay
}

const liveHybridTestsEnabled = process.env.PCE_LIVE_TESTS === "true";

/**
 * TL-2A.7: Hybrid Reasoning Gold Path Validation
 * 
 * This test validates the end-to-end flow where the LLM combines:
 * 1. Live Tool Data: Direct Proxmox API calls (e.g., VM status, CPU usage)
 * 2. Vector RAG Data: Previously ingested context (e.g., runbooks, policies)
 * 3. Graph RAG Data: Structural information (e.g., VM runs on Node, Node connects to Storage)
 * 
 * The LLM must synthesize a single, grounded response using all three data sources.
 */

describe("TL-2A.7: Hybrid Reasoning Gold Path Validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      // Use real Proxmox credentials if available, otherwise use mocks
      PROXMOX_URL: originalEnv.PROXMOX_URL || "https://proxmox.example.com",
      PROXMOX_TOKEN_ID: originalEnv.PROXMOX_TOKEN_ID || "testuser@pam!testtoken",
      PROXMOX_TOKEN_SECRET: originalEnv.PROXMOX_TOKEN_SECRET || "test-secret",
      PROXMOX_VERIFY_SSL: originalEnv.PROXMOX_VERIFY_SSL || "false",
      PCE_API_URL: originalEnv.PCE_API_URL || "http://localhost:4000",
      OPENAI_API_KEY: originalEnv.OPENAI_API_KEY || "test-key",
    };

    // Mock fetch for PCE API calls (Vector RAG and Graph RAG)
    // Note: In bun:test, we use spyOn instead of vi.fn()
    // The mock will be set up in each test that needs it
  });

  afterEach(() => {
    process.env = originalEnv;
    // Note: individual tests restore global.fetch after themselves
  });

  test("should have Proxmox read-only tool loaded", () => {
    const tools = loadTools();
    const proxmoxTool = tools.find((t) => t.metadata.name === "proxmox_readonly");
    
    expect(proxmoxTool).toBeDefined();
    expect(proxmoxTool).toBeInstanceOf(ProxmoxReadOnlyTool);
  });

  test("should have required Proxmox actions available", () => {
    const tool = new ProxmoxReadOnlyTool();
    const schema = tool.getSchema();
    const params = schema.parameters as any;
    const actions = params.properties?.action?.enum || [];
    
    // Verify required actions for gold path scenario
    expect(actions).toContain("get_vm_status");
    expect(actions).toContain("cluster_resources");
    expect(actions).toContain("list_nodes");
    expect(actions).toContain("list_vms");
  });

  // TODO(RM-17): Replace the live OpenAI and Proxmox dependencies with
  // injected deterministic clients before promoting these to offline fixtures.
  test.skipIf(!liveHybridTestsEnabled)("should execute hybrid reasoning gold path query", async () => {

    // Gold Path Scenario:
    // Query: "Is VM-101 running at high CPU? Should we reboot it based on Infrastructure team policies?"
    // 
    // Expected data sources:
    // 1. Live Tool: get_vm_status for VM-101 (current CPU usage, status)
    // 2. Vector RAG: Ingested document about VM-101 ownership and reboot policies
    // 3. Graph RAG: VM-101 runs on Node-03, Node-03 connects to Storage-A

    // Mock Vector RAG response (previously ingested context)
    const vectorRagResponse = {
      vectorResults: [
        {
          content: "VM-101 is owned by the Infrastructure team and requires an emergency reboot if CPU usage exceeds 90% for more than 5 minutes. Contact: infra-team@example.com",
          metadata: {
            source: "proxmox_vm_inventory",
            vmid: "101",
            timestamp: new Date().toISOString(),
          },
          score: 0.95,
        },
      ],
      graphResults: [
        {
          nodes: [
            {
              id: "vm:101",
              type: "VM_INSTANCE",
              attributes: {
                vmid: 101,
                name: "VM-101",
                status: "running",
              },
            },
            {
              id: "node:pve3",
              type: "PVE_NODE",
              attributes: {
                node: "pve3",
                status: "online",
              },
            },
            {
              id: "storage:local-lvm",
              type: "PVE_STORAGE",
              attributes: {
                storage: "local-lvm",
                type: "lvm",
              },
            },
          ],
          relationships: [
            {
              id: "rel:1",
              type: "RUNS_ON",
              source: "vm:101",
              target: "node:pve3",
            },
            {
              id: "rel:2",
              type: "CONNECTED_TO",
              source: "storage:local-lvm",
              target: "node:pve3",
            },
          ],
        },
      ],
    };

    // Mock fetch for PCE API calls only (let OpenAI calls pass through)
    const originalFetch = global.fetch;
    global.fetch = (async (url: string | Request | URL, init?: RequestInit) => {
      const urlString = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      
      // Only mock PCE API calls (those containing /query or PCE_API_URL)
      if (urlString.includes('/query') || urlString.includes('localhost:4000') || urlString.includes(process.env.PCE_API_URL || '')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => vectorRagResponse,
        } as Response;
      }
      
      // For all other calls (like OpenAI), use the real fetch
      return originalFetch(url, init);
    }) as any;

    // Execute the gold path query
    const query = "Is VM-101 running at high CPU? Should we reboot it based on Infrastructure team policies?";
    
    let proxmoxExecuteCount = 0;
    const originalProxmoxExecute = ProxmoxReadOnlyTool.prototype.execute;
    ProxmoxReadOnlyTool.prototype.execute = async function (params: any, context: any) {
      proxmoxExecuteCount++;
      return originalProxmoxExecute.call(this, params, context);
    };

    let response;
    try {
      response = await runAgent(query, {
        userId: "test-user",
        aclGroup: "viewer",
        ragBaseUrl: process.env.PCE_API_URL || "http://localhost:4000",
      });
    } finally {
      global.fetch = originalFetch;
      ProxmoxReadOnlyTool.prototype.execute = originalProxmoxExecute;
    }

    // Validate response structure
    expect(response).toBeDefined();
    expect(response.text).toBeDefined();
    expect(typeof response.text).toBe("string");
    expect(response.text).toMatch(/vm[- ]?101/i);
    expect(response.text).toMatch(/90\s*%|90 percent/i);
    expect(proxmoxExecuteCount).toBeGreaterThan(0);
  }, 30000); // 30 second timeout for LLM calls

  test.skipIf(!liveHybridTestsEnabled)("should handle query requiring all three data sources", async () => {

    // Complex query that requires:
    // 1. Live tool: Current VM status and resource usage
    // 2. Vector RAG: Historical patterns, runbooks
    // 3. Graph RAG: Infrastructure topology

    const complexQuery = 
      "VM-101 on node pve3 has been experiencing high CPU. " +
      "Based on our infrastructure documentation and the cluster topology, " +
      "what should we do? Check the current status first.";

    // Mock fetch for PCE API calls only (let OpenAI calls pass through)
    const originalFetch = global.fetch;
    const mockRagResponse = {
      vectorResults: [
        {
          content: "VM-101 is a critical production VM. High CPU (>90%) for >5min requires immediate investigation. Standard procedure: check load, then consider migration to less loaded node.",
          metadata: { source: "proxmox_node_profile", node: "pve3" },
          score: 0.92,
        },
      ],
      graphResults: [
        {
          nodes: [
            { id: "vm:101", type: "VM_INSTANCE", attributes: { vmid: 101, name: "VM-101" } },
            { id: "node:pve3", type: "PVE_NODE", attributes: { node: "pve3" } },
            { id: "node:pve1", type: "PVE_NODE", attributes: { node: "pve1" } },
          ],
          relationships: [
            { id: "rel:1", type: "RUNS_ON", source: "vm:101", target: "node:pve3" },
            { id: "rel:2", type: "CONNECTS_TO", source: "node:pve3", target: "node:pve1" },
          ],
        },
      ],
    };
    
    global.fetch = (async (url: string | Request | URL, init?: RequestInit) => {
      const urlString = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      
      // Only mock PCE API calls (those containing /query or PCE_API_URL)
      if (urlString.includes('/query') || urlString.includes('localhost:4000') || urlString.includes(process.env.PCE_API_URL || '')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => mockRagResponse,
        } as Response;
      }
      
      // For all other calls (like OpenAI), use the real fetch
      return originalFetch(url, init);
    }) as any;

    const response = await runAgent(complexQuery, {
      userId: "test-user",
      aclGroup: "viewer",
      ragBaseUrl: process.env.PCE_API_URL || "http://localhost:4000",
    });

    expect(response).toBeDefined();
    expect(response.text).toBeDefined();
    expect(typeof response.text).toBe("string");
    expect(response.text).toMatch(/vm[- ]?101/i);
    expect(response.text).toMatch(/pve3/i);

    // Restore original fetch
    global.fetch = originalFetch;
  }, 30000); // 30 second timeout for LLM calls

  test.skipIf(!liveHybridTestsEnabled)("should validate provenance chain across all data sources", async () => {

    const query = "What is the status of VM-101 and which node is it running on?";

    // Mock fetch for PCE API calls only (let OpenAI calls pass through)
    const originalFetch = global.fetch;
    const mockRagResponse = {
      vectorResults: [],
      graphResults: [
        {
          nodes: [
            { id: "vm:101", type: "VM_INSTANCE", attributes: { vmid: 101 } },
            { id: "node:pve3", type: "PVE_NODE", attributes: { node: "pve3" } },
          ],
          relationships: [
            { id: "rel:1", type: "RUNS_ON", source: "vm:101", target: "node:pve3" },
          ],
        },
      ],
    };
    
    global.fetch = (async (url: string | Request | URL, init?: RequestInit) => {
      const urlString = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      
      // Only mock PCE API calls (those containing /query or PCE_API_URL)
      if (urlString.includes('/query') || urlString.includes('localhost:4000') || urlString.includes(process.env.PCE_API_URL || '')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'Content-Type': 'application/json' }),
          json: async () => mockRagResponse,
        } as Response;
      }
      
      // For all other calls (like OpenAI), use the real fetch
      return originalFetch(url, init);
    }) as any;

    const response = await runAgent(query, {
      userId: "test-user",
      aclGroup: "viewer",
      ragBaseUrl: process.env.PCE_API_URL || "http://localhost:4000",
    });

    expect(response).toBeDefined();
    expect(response.text).toBeDefined();
    
    expect(response.text).toMatch(/vm[- ]?101/i);
    expect(response.text).toMatch(/pve3/i);
    
    // Restore original fetch
    global.fetch = originalFetch;
  }, 30000); // 30 second timeout for LLM calls
});
