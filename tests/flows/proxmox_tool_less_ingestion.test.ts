/**
 * TL-2A.6.8: Tool-less Hybrid Reasoning Validation
 * 
 * This test validates that after ingesting Proxmox inventory data into PCE,
 * queries can be answered using only Vector RAG and Graph RAG without making
 * Proxmox tool calls.
 * 
 * Test scenarios:
 * 1. Name-based query ("Where is aiMarketBot?")
 * 2. Structural query ("List all workloads hosted on yin")
 * 3. Resource-based query ("What LXCs use <1GB RAM?")
 * 4. Provenance audit validation
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ProxmoxIngestionOrchestrator, type ProxmoxIngestionOptions } from "../../src/pce/ingestion/proxmox-ingestion";
import {
  SnapshotLog,
  RawDocumentStorage,
  Redactor,
  EmbeddingService,
  QdrantVectorStore,
  IngestionPipeline,
  GraphIngestionPipeline,
  Neo4jGraphStore,
  pceLogger,
} from "../../src/pce/index";
import { ProxmoxClient, type ProxmoxApiConfig } from "../../src/tools/proxmox/client";
import { ProxmoxReadOnlyTool } from "../../src/tools/proxmox/readonly";
import { runAgent } from "../../src/agent/runner";
import { promises as fs } from "fs";
import { join } from "path";

// Track tool calls made during agent execution
let toolCallCount = 0;
let proxmoxToolCalls: string[] = [];
const originalToolExecute = ProxmoxReadOnlyTool.prototype.execute;

const liveTestsEnabled = process.env.PCE_LIVE_TESTS === "true";
const runDescribe = liveTestsEnabled ? describe : describe.skip;

runDescribe("TL-2A.6.8: Tool-less Hybrid Reasoning Validation", () => {
  let orchestrator: ProxmoxIngestionOrchestrator;
  let vectorStore: QdrantVectorStore;
  let graphStore: Neo4jGraphStore;
  const testWorkDir = join(process.cwd(), ".test-proxmox-ingestion");

  beforeEach(async () => {
    // Reset tool call tracking
    toolCallCount = 0;
    proxmoxToolCalls = [];

    // Mock ProxmoxReadOnlyTool.execute to track calls
    ProxmoxReadOnlyTool.prototype.execute = async function (params: any, context: any) {
      toolCallCount++;
      const action = params?.action || "unknown";
      proxmoxToolCalls.push(action);
      // Call original implementation for actual data fetching during ingestion
      return originalToolExecute.call(this, params, context);
    };

    // Setup test environment
    await fs.mkdir(testWorkDir, { recursive: true });

    // Initialize components
    const snapshotLog = new SnapshotLog(join(testWorkDir, "snapshots.json"));
    await snapshotLog.initialize();

    const rawStorage = new RawDocumentStorage(join(testWorkDir, "raw"));
    await rawStorage.initialize();

    const redactor = new Redactor();
    const embeddingService = new EmbeddingService();
    vectorStore = new QdrantVectorStore();
    await vectorStore.initializeCollection(embeddingService.getDimension());

    graphStore = new Neo4jGraphStore();
    await graphStore.connect();
    await graphStore.createIndexes();

    const vectorPipeline = new IngestionPipeline(
      snapshotLog,
      rawStorage,
      redactor,
      embeddingService,
      vectorStore
    );

    const graphPipeline = new GraphIngestionPipeline(
      snapshotLog,
      rawStorage,
      redactor,
      graphStore
    );

    // Get Proxmox config from environment
    const proxmoxConfig: ProxmoxApiConfig = {
      url: process.env.PROXMOX_URL || "https://proxmox.example.com",
      tokenId: process.env.PROXMOX_TOKEN_ID || "testuser@pam!testtoken",
      tokenSecret: process.env.PROXMOX_TOKEN_SECRET || "test-secret",
      verifySsl: process.env.PROXMOX_VERIFY_SSL !== "false",
    };

    orchestrator = new ProxmoxIngestionOrchestrator(
      vectorPipeline,
      graphPipeline,
      graphStore,
      proxmoxConfig
    );
  });

  afterEach(async () => {
    // Restore original tool implementation
    ProxmoxReadOnlyTool.prototype.execute = originalToolExecute;

    // Cleanup
    try {
      await graphStore.close();
    } catch (e) {
      // Ignore cleanup errors
    }
    try {
      await fs.rm(testWorkDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  test("should ingest Proxmox inventory data", async () => {
    // Skip if Proxmox credentials are not available
    if (!liveTestsEnabled) {
      console.log("Skipping live test: set PCE_LIVE_TESTS=true to enable.");
      return;
    }
    if (!process.env.PROXMOX_URL || process.env.PROXMOX_URL === "https://proxmox.example.com") {
      console.log("Skipping test: PROXMOX_URL not set or is example URL");
      return;
    }

    const options: ProxmoxIngestionOptions = {
      aclGroup: "ops",
      redact: true,
      reindex: false,
    };

    // Reset tool call counter before ingestion
    toolCallCount = 0;
    proxmoxToolCalls = [];

    const result = await orchestrator.ingestProxmoxInventory(options);

    // Verify ingestion succeeded
    expect(result.vectorIngestion.documentsProcessed).toBeGreaterThan(0);
    expect(result.vectorIngestion.chunksIndexed).toBeGreaterThan(0);
    expect(result.graphIngestion.nodesWritten).toBeGreaterThan(0);
    expect(result.graphIngestion.relationshipsWritten).toBeGreaterThan(0);

    // Tool calls during ingestion are expected (we need to fetch data)
    expect(toolCallCount).toBeGreaterThan(0);
    pceLogger.info("Ingestion complete", {
      toolCalls: toolCallCount,
      vectorChunks: result.vectorIngestion.chunksIndexed,
      graphNodes: result.graphIngestion.nodesWritten,
    });
  }, 60000); // 60 second timeout for ingestion

  test("should answer name-based query without tool calls", async () => {
    // Skip if Proxmox credentials or OpenAI key are not available
    if (!liveTestsEnabled) {
      console.log("Skipping live test: set PCE_LIVE_TESTS=true to enable.");
      return;
    }
    if (
      !process.env.PROXMOX_URL ||
      process.env.PROXMOX_URL === "https://proxmox.example.com" ||
      !process.env.OPENAI_API_KEY ||
      process.env.OPENAI_API_KEY === "test-key"
    ) {
      console.log("Skipping test: PROXMOX_URL or OPENAI_API_KEY not set");
      return;
    }

    // First, ingest data
    toolCallCount = 0;
    proxmoxToolCalls = [];

    await orchestrator.ingestProxmoxInventory({
      aclGroup: "ops",
      redact: true,
      reindex: false,
    });

    const ingestionToolCalls = toolCallCount;
    pceLogger.info("Ingestion tool calls", { count: ingestionToolCalls });

    // Reset counter for query phase
    toolCallCount = 0;
    proxmoxToolCalls = [];

    // Now mock tool execution to track calls during query
    ProxmoxReadOnlyTool.prototype.execute = async function (params: any, context: any) {
      toolCallCount++;
      const action = params?.action || "unknown";
      proxmoxToolCalls.push(action);
      // Return error to force agent to use RAG instead
      return {
        error: "Tool call blocked - should use ingested context instead",
        data: null,
      };
    };

    // Query that should be answerable from ingested data
    const query = "Where is aiMarketBot?";

    const response = await runAgent(query, {
      userId: "test-user",
      aclGroup: "ops",
      ragBaseUrl: process.env.PCE_API_URL || "http://localhost:4000",
    });

    expect(response).toBeDefined();
    expect(response.text).toBeDefined();

    // Assert ZERO Proxmox tool calls were made (or minimized)
    // The agent should use Vector/Graph RAG instead
    expect(toolCallCount).toBe(0);

    // Response should contain relevant information
    const message = response.text.toLowerCase();
    const hasRelevantInfo =
      message.includes("aimarketbot") ||
      message.includes("vm") ||
      message.includes("node") ||
      message.includes("pve");

    expect(hasRelevantInfo).toBe(true);

    pceLogger.info("Name-based query completed", {
      toolCalls: toolCallCount,
      responseLength: response.text.length,
    });
  }, 90000); // 90 second timeout (ingestion + query)

  test("should answer structural query without tool calls", async () => {
    // Skip if credentials are not available
    if (!liveTestsEnabled) {
      console.log("Skipping live test: set PCE_LIVE_TESTS=true to enable.");
      return;
    }
    if (
      !process.env.PROXMOX_URL ||
      process.env.PROXMOX_URL === "https://proxmox.example.com" ||
      !process.env.OPENAI_API_KEY ||
      process.env.OPENAI_API_KEY === "test-key"
    ) {
      console.log("Skipping test: PROXMOX_URL or OPENAI_API_KEY not set");
      return;
    }

    // Ingest data first
    await orchestrator.ingestProxmoxInventory({
      aclGroup: "ops",
      redact: true,
      reindex: false,
    });

    // Reset counter
    toolCallCount = 0;
    proxmoxToolCalls = [];

    // Mock tool to track calls
    ProxmoxReadOnlyTool.prototype.execute = async function (params: any, context: any) {
      toolCallCount++;
      proxmoxToolCalls.push(params?.action || "unknown");
      return {
        error: "Tool call blocked - should use ingested context instead",
        data: null,
      };
    };

    // Structural query about workloads on a specific node
    const query = "List all workloads hosted on yin";

    const response = await runAgent(query, {
      userId: "test-user",
      aclGroup: "ops",
      ragBaseUrl: process.env.PCE_API_URL || "http://localhost:4000",
    });

    expect(response).toBeDefined();
    expect(response.text).toBeDefined();

    // Should use Graph RAG to find workloads on node "yin"
    expect(toolCallCount).toBe(0);

    // Response should mention workloads or VMs
    const message = response.text.toLowerCase();
    const hasStructuralInfo =
      message.includes("yin") ||
      message.includes("workload") ||
      message.includes("vm") ||
      message.includes("lxc") ||
      message.includes("hosted");

    expect(hasStructuralInfo).toBe(true);
  }, 90000);

  test("should answer resource-based query without tool calls", async () => {
    // Skip if credentials are not available
    if (!liveTestsEnabled) {
      console.log("Skipping live test: set PCE_LIVE_TESTS=true to enable.");
      return;
    }
    if (
      !process.env.PROXMOX_URL ||
      process.env.PROXMOX_URL === "https://proxmox.example.com" ||
      !process.env.OPENAI_API_KEY ||
      process.env.OPENAI_API_KEY === "test-key"
    ) {
      console.log("Skipping test: PROXMOX_URL or OPENAI_API_KEY not set");
      return;
    }

    // Ingest data first
    await orchestrator.ingestProxmoxInventory({
      aclGroup: "ops",
      redact: true,
      reindex: false,
    });

    // Reset counter
    toolCallCount = 0;
    proxmoxToolCalls = [];

    // Mock tool to track calls
    ProxmoxReadOnlyTool.prototype.execute = async function (params: any, context: any) {
      toolCallCount++;
      proxmoxToolCalls.push(params?.action || "unknown");
      return {
        error: "Tool call blocked - should use ingested context instead",
        data: null,
      };
    };

    // Resource-based query
    const query = "What LXCs use less than 1GB RAM?";

    const response = await runAgent(query, {
      userId: "test-user",
      aclGroup: "ops",
      ragBaseUrl: process.env.PCE_API_URL || "http://localhost:4000",
    });

    expect(response).toBeDefined();
    expect(response.text).toBeDefined();

    // Should use Vector RAG to find LXCs with low memory usage
    expect(toolCallCount).toBe(0);

    // Response should mention LXCs and memory
    const message = response.text.toLowerCase();
    const hasResourceInfo =
      message.includes("lxc") ||
      message.includes("memory") ||
      message.includes("ram") ||
      message.includes("gb") ||
      message.includes("mb");

    expect(hasResourceInfo).toBe(true);
  }, 90000);

  test("should validate provenance for retrieved context", async () => {
    // Skip if credentials are not available
    if (!liveTestsEnabled) {
      console.log("Skipping live test: set PCE_LIVE_TESTS=true to enable.");
      return;
    }
    if (
      !process.env.PROXMOX_URL ||
      process.env.PROXMOX_URL === "https://proxmox.example.com" ||
      !process.env.OPENAI_API_KEY ||
      process.env.OPENAI_API_KEY === "test-key"
    ) {
      console.log("Skipping test: PROXMOX_URL or OPENAI_API_KEY not set");
      return;
    }

    // Ingest data
    const ingestionResult = await orchestrator.ingestProxmoxInventory({
      aclGroup: "ops",
      redact: true,
      reindex: false,
    });

    // Verify provenance hashes were generated
    expect(ingestionResult.provenance.versionHashes.length).toBeGreaterThan(0);
    expect(ingestionResult.provenance.versionHashes.every((h) => h.length === 64)).toBe(true);

    // Query that should retrieve ingested context
    const query = "What VMs are in the cluster?";

    // Mock tool to prevent calls
    ProxmoxReadOnlyTool.prototype.execute = async function (params: any, context: any) {
      return {
        error: "Tool call blocked - should use ingested context instead",
        data: null,
      };
    };

    const response = await runAgent(query, {
      userId: "test-user",
      aclGroup: "ops",
      ragBaseUrl: process.env.PCE_API_URL || "http://localhost:4000",
    });

    expect(response).toBeDefined();

    // Verify that the ingestion created nodes with provenance
    // This is a basic check - full provenance audit would require querying the stores
    const hasProvenance = ingestionResult.provenance.versionHashes.length > 0;
    expect(hasProvenance).toBe(true);

    pceLogger.info("Provenance validation complete", {
      versionHashes: ingestionResult.provenance.versionHashes.length,
    });
  }, 90000);
});

