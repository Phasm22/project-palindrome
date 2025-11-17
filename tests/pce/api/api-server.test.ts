import { describe, it, expect, afterEach } from "bun:test";
import type { HybridRAGResponse, HybridContext, DocumentChunk } from "../../../src/pce/types";
import { PceApiServer, type PceApiServerOptions, type PceApiServerDependencies } from "../../../src/pce/api/server";
import type { DependencyHealthCheck } from "../../../src/pce/api/types";
import { ContextHistoryStore } from "../../../src/pce/api/history-store";
import { MetricsCollector, QueryMetrics, ErrorMetrics } from "../../../src/pce/metrics";
import { AccessDeniedError } from "../../../src/pce/errors";

const baseChunk: DocumentChunk = {
  id: "chunk-1",
  text: "Firewall rules are stored at /etc/firewall/rules.conf",
  metadata: {
    versionHash: "hash-123",
    aclGroup: "admin",
    sourceType: "markdown_runbook",
    sourcePath: "/tmp/runbook.md",
    timestamp: new Date("2024-01-01T00:00:00Z"),
    chunkIndex: 0,
    totalChunks: 1,
  },
  startIndex: 0,
  endIndex: 60,
};

const baseContext: HybridContext = {
  semanticChunks: [
    {
      chunk: baseChunk,
      score: 0.92,
    },
  ],
  structuralPaths: [],
  provenance: [
    {
      versionHash: baseChunk.metadata.versionHash,
      sourcePath: baseChunk.metadata.sourcePath,
    },
  ],
};

const baseResponse: HybridRAGResponse = {
  answer: "Firewall rules live at /etc/firewall/rules.conf",
  queryType: "HYBRID",
  fallbackMode: null,
  sources: [
    {
      chunkId: baseChunk.id,
      sourcePath: baseChunk.metadata.sourcePath,
      score: 0.92,
      text: baseChunk.text,
    },
  ],
  metadata: {
    tokensUsed: 42,
    chunksRetrieved: 1,
  },
  fusionMetrics: {
    vectorResults: 1,
    graphResults: 0,
    fusedResults: 1,
    prunedResults: 1,
    avgTotalScore: 0.85,
  },
  context: baseContext,
  sTotalScore: 0.85,
};

class MockOrchestrator implements PceApiServerDependencies["orchestrator"] {
  private response: HybridRAGResponse;

  constructor(response: HybridRAGResponse = baseResponse) {
    this.response = response;
  }

  async query(): Promise<HybridRAGResponse> {
    return this.response;
  }
}

async function startTestServer(
  options: Partial<PceApiServerOptions> = {},
  overrides: Partial<PceApiServerDependencies> = {}
) {
  const historyStore = overrides.historyStore ?? new ContextHistoryStore(5);
  const metricsCollector = overrides.metricsCollector ?? new MetricsCollector();
  const queryMetrics = overrides.queryMetrics ?? new QueryMetrics(metricsCollector);
  const errorMetrics = overrides.errorMetrics ?? new ErrorMetrics(metricsCollector);
  const dependencyChecks =
    overrides.dependencyChecks ?? ([
      { name: "vector_store", check: async () => true },
      { name: "graph_store", check: async () => false },
    ] satisfies DependencyHealthCheck[]);

  const orchestrator = overrides.orchestrator ?? new MockOrchestrator();

  const server = new PceApiServer(
    {
      orchestrator,
      historyStore,
      metricsCollector,
      queryMetrics,
      errorMetrics,
      dependencyChecks,
    },
    { port: 0, ...options }
  );

  await server.start();
  const baseUrl = `http://localhost:${server.getPort()}`;

  return { server, baseUrl, historyStore, metricsCollector };
}

const servers: PceApiServer[] = [];
afterEach(async () => {
  while (servers.length) {
    const instance = servers.pop();
    if (instance) {
      await instance.stop();
    }
  }
});

describe("PCE API server", () => {
  it("returns structured query response and stores history", async () => {
    const { server, baseUrl } = await startTestServer();
    servers.push(server);

    const res = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Where are firewall rules?", aclGroup: "admin", userId: "user-1" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBeTrue();
    expect(body.data.context.semanticChunks).toHaveLength(1);
    expect(body.data.answer).toContain("/etc/firewall/rules.conf");
    expect(body.data.sTotalScore).toBeCloseTo(0.85, 2);

    const historyRes = await fetch(`${baseUrl}/history/user-1`);
    expect(historyRes.status).toBe(200);
    const history = await historyRes.json();
    expect(history.data.entries).toHaveLength(1);
    expect(history.data.entries[0].response.context.semanticChunks[0].sourcePath).toBe(
      baseChunk.metadata.sourcePath
    );
  });

  it("enforces per-IP rate limits", async () => {
    const { server, baseUrl } = await startTestServer({ perIpRateLimit: { windowMs: 60_000, max: 1 } });
    servers.push(server);

    const ok = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "first", aclGroup: "admin", userId: "user-2" }),
    });
    expect(ok.status).toBe(200);

    const limited = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "second", aclGroup: "admin", userId: "user-2" }),
    });

    expect(limited.status).toBe(429);
    const limitedBody = await limited.json();
    expect(limitedBody.error).toContain("Rate limit");
    expect(limitedBody.scope).toBe("ip");
  });

  it("exposes metrics and health status", async () => {
    const dependencyChecks: DependencyHealthCheck[] = [
      { name: "vector_store", check: async () => true },
      { name: "graph_store", check: async () => false },
    ];
    const { server, baseUrl } = await startTestServer({}, { dependencyChecks });
    servers.push(server);

    await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "status", aclGroup: "admin", userId: "observer" }),
    });

    const metricsRes = await fetch(`${baseUrl}/metrics`);
    expect(metricsRes.status).toBe(200);
    const metricsBody = await metricsRes.json();
    expect(metricsBody.data.snapshot).toBeDefined();

    const healthRes = await fetch(`${baseUrl}/health`);
    const healthBody = await healthRes.json();
    expect(healthBody.data.dependencies).toHaveLength(2);
    const graphStatus = healthBody.data.dependencies.find((d: any) => d.name === "graph_store");
    expect(graphStatus.healthy).toBeFalse();
    expect(healthBody.success).toBeFalse();
  });

  it("returns access denied when the orchestrator blocks ACL violations", async () => {
    const orchestrator = new MockOrchestrator();
    orchestrator.query = async () => {
      throw new AccessDeniedError({
        reason: "SEMANTIC_ACL_FILTERED",
        matchedCount: 3,
        filteredCount: 0,
      });
    };

    const { server, baseUrl } = await startTestServer({}, { orchestrator });
    servers.push(server);

    const res = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Where", aclGroup: "viewer", userId: "blocked" }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.success).toBeFalse();
    expect(body.error).toBe("ACCESS_DENIED");
    expect(body.details.reason).toBe("SEMANTIC_ACL_FILTERED");
    expect(body.details.matchedCount).toBe(3);
  });

  it("redacts answers and context before returning them", async () => {
    const sensitiveChunk: DocumentChunk = {
      ...baseChunk,
      text: "Reach us at user@example.com",
    };

    const sensitiveContext: HybridContext = {
      semanticChunks: [
        {
          chunk: sensitiveChunk,
          score: 0.9,
        },
      ],
      structuralPaths: [],
      provenance: [
        {
          versionHash: sensitiveChunk.metadata.versionHash,
          sourcePath: sensitiveChunk.metadata.sourcePath,
        },
      ],
    };

    const sensitiveResponse: HybridRAGResponse = {
      ...baseResponse,
      answer: "password=NeverShareThis",
      sources: [
        {
          ...baseResponse.sources[0],
          text: "password=NeverShareThis",
        },
      ],
      context: sensitiveContext,
    };

    const orchestrator = new MockOrchestrator(sensitiveResponse);
    const { server, baseUrl } = await startTestServer({}, { orchestrator });
    servers.push(server);

    const res = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Where", aclGroup: "admin", userId: "redact" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.answer).toContain("[REDACTED_PASSWORD]");
    expect(body.data.sources[0].text).toContain("[REDACTED_PASSWORD]");
    expect(body.data.context.semanticChunks[0].text).toContain("[REDACTED_EMAIL]");
  });
});
