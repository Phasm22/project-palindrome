import { z } from "zod";
import type { ACLGroup, FusionConfig, HybridRAGResponse, QueryType } from "../types";
import { pceLogger } from "../utils/logger";
import { Redactor } from "../redaction/redactor";
import { AccessDeniedError } from "../errors";
import { MetricsCollector, QueryMetrics, ErrorMetrics } from "../metrics";
import { HybridOrchestrator, QueryAnalyzer, QueryEntityResolver, FusionEngine, RetrievalService, GenerationService } from "../rag";
import { GraphRAGRetrieval } from "../graph-retrieval";
import { GraphQueryInterface, Neo4jGraphStore } from "../kg";
import { EmbeddingService, QdrantVectorStore } from "../vector";
import type { ApiHistoryPayload, ApiQueryResponse, DependencyHealthCheck, HealthPayload, MetricsPayload } from "./types";
import { ApiRateLimiter, type RateLimitConfig } from "./rate-limiter";
import { ContextHistoryStore } from "./history-store";
import { transformHybridContext } from "./context-transformer";

type BunServer = ReturnType<typeof Bun.serve>;

const QueryRequestSchema = z.object({
  query: z.string().min(1),
  aclGroup: z.string().min(1).default("viewer"),
  userId: z.string().min(1),
  metadata: z.record(z.string(), z.any()).optional(),
});

const DEFAULT_OPTIONS = {
  port: Number(process.env.PCE_API_PORT || 4000),
  historyLimit: 25,
  globalRateLimit: { windowMs: 60_000, max: 10 } satisfies RateLimitConfig,
  perIpRateLimit: { windowMs: 60_000, max: 5 } satisfies RateLimitConfig,
};

export interface PceApiServerOptions {
  port?: number;
  historyLimit?: number;
  globalRateLimit?: RateLimitConfig;
  perIpRateLimit?: RateLimitConfig;
}

export interface PceApiServerDependencies {
  orchestrator: {
    query: (query: string, aclGroup: ACLGroup) => Promise<HybridRAGResponse>;
  };
  historyStore?: ContextHistoryStore;
  metricsCollector?: MetricsCollector;
  queryMetrics?: QueryMetrics;
  errorMetrics?: ErrorMetrics;
  dependencyChecks?: DependencyHealthCheck[];
  cleanupHandlers?: Array<() => Promise<void> | void>;
}

export class PceApiServer {
  private server: BunServer | null = null;
  private options: Required<PceApiServerOptions>;
  private orchestrator: PceApiServerDependencies["orchestrator"];
  private historyStore: ContextHistoryStore;
  private metricsCollector: MetricsCollector;
  private queryMetrics: QueryMetrics;
  private errorMetrics: ErrorMetrics;
  private dependencyChecks: DependencyHealthCheck[];
  private cleanupHandlers: Array<() => Promise<void> | void>;
  private rateLimiter: ApiRateLimiter;
  private ownsMetricsCollector: boolean;
  private startTime = Date.now();
  private redactor: Redactor;

  constructor(deps: PceApiServerDependencies, options: PceApiServerOptions = {}) {
    this.options = {
      port: options.port ?? DEFAULT_OPTIONS.port,
      historyLimit: options.historyLimit ?? DEFAULT_OPTIONS.historyLimit,
      globalRateLimit: options.globalRateLimit ?? DEFAULT_OPTIONS.globalRateLimit,
      perIpRateLimit: options.perIpRateLimit ?? DEFAULT_OPTIONS.perIpRateLimit,
    };

    this.orchestrator = deps.orchestrator;
    this.historyStore = deps.historyStore ?? new ContextHistoryStore(this.options.historyLimit);
    this.metricsCollector = deps.metricsCollector ?? new MetricsCollector();
    this.ownsMetricsCollector = !deps.metricsCollector;
    this.queryMetrics = deps.queryMetrics ?? new QueryMetrics(this.metricsCollector);
    this.errorMetrics = deps.errorMetrics ?? new ErrorMetrics(this.metricsCollector);
    this.dependencyChecks = deps.dependencyChecks ?? [];
    this.cleanupHandlers = deps.cleanupHandlers ?? [];
    this.rateLimiter = new ApiRateLimiter(
      this.options.globalRateLimit,
      this.options.perIpRateLimit
    );
    this.redactor = new Redactor();
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error("PCE API server is already running");
    }

    this.server = Bun.serve({
      hostname: "0.0.0.0", // Bind to all interfaces (IPv4) for Docker access
      port: this.options.port,
      fetch: (req, server) => this.handleRequest(req, server),
    });

    pceLogger.info("PCE API server started", {
      port: this.server.port,
      url: `http://localhost:${this.server.port}`,
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop();
      this.server = null;
      pceLogger.info("PCE API server stopped");
    }

    if (this.ownsMetricsCollector) {
      this.metricsCollector.shutdown();
    }

    for (const handler of this.cleanupHandlers) {
      await handler();
    }
  }

  getPort(): number | null {
    return this.server?.port ?? null;
  }

  private async handleRequest(req: Request, server: BunServer): Promise<Response> {
    const url = new URL(req.url);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/query") {
      return await this.handleQuery(req, server);
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      // Check if Prometheus format is requested
      const acceptHeader = req.headers.get("accept") || "";
      const formatParam = url.searchParams.get("format");
      // Also check URL directly as fallback
      const urlString = req.url.toLowerCase();
      const wantsPrometheus = 
        acceptHeader.includes("application/openmetrics-text") || 
        formatParam === "prometheus" ||
        urlString.includes("format=prometheus");
      
      if (wantsPrometheus) {
        return this.handlePrometheusMetrics();
      }
      return this.handleMetrics();
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return await this.handleHealth();
    }

    if (req.method === "GET" && url.pathname.startsWith("/history/")) {
      return this.handleHistory(url.pathname);
    }

    // Dashboard API endpoints
    if (req.method === "GET" && url.pathname === "/api/dashboard/tool-executions") {
      return await this.handleToolExecutions(req);
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard/cluster-status") {
      return await this.handleClusterStatus(req);
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard/ontology-graph") {
      return await this.handleOntologyGraph(req);
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard/vector-stats") {
      return await this.handleVectorStats(req);
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard/rag-diagnostics") {
      return await this.handleRagDiagnostics(req);
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard/execution-stats") {
      return await this.handleExecutionStats(req);
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard/reasoning-traces") {
      return await this.handleReasoningTraces(req);
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/dashboard/reasoning-traces/")) {
      return await this.handleReasoningTrace(req, url.pathname);
    }

    // Unified query endpoints
    if (req.method === "POST" && url.pathname === "/api/dashboard/query/rag") {
      return await this.handleDashboardRagQuery(req);
    }

    if (req.method === "POST" && url.pathname === "/api/dashboard/query/graph") {
      return await this.handleDashboardGraphQuery(req);
    }

    if (req.method === "POST" && url.pathname === "/api/dashboard/query/cypher") {
      return await this.handleDashboardCypherQuery(req);
    }

    return this.jsonResponse(404, { error: "Not Found" });
  }

  private async handleQuery(req: Request, server: BunServer): Promise<Response> {
    const clientIp = this.extractClientIp(req, server);
    const rateResult = this.rateLimiter.check(clientIp);

    if (!rateResult.allowed) {
      pceLogger.warn("API rate limit triggered", {
        scope: rateResult.scope,
        retryAfterMs: rateResult.retryAfterMs,
      });
      pceLogger.incrementCounter(
        rateResult.scope === "global" ? "api_rate_limit_global" : "api_rate_limit_ip"
      );

      return this.jsonResponse(429, {
        success: false,
        error: "Rate limit exceeded",
        retryAfterMs: rateResult.retryAfterMs,
        scope: rateResult.scope,
      });
    }

    let payload: z.infer<typeof QueryRequestSchema>;
    try {
      const body = (await req.json()) as {
        query?: string;
        userId?: string;
        aclGroup?: ACLGroup;
      };
      payload = QueryRequestSchema.parse(body);
    } catch (error: any) {
      return this.jsonResponse(400, {
        success: false,
        error: "Invalid request body",
        details: error?.message,
      });
    }

    const start = Date.now();

    try {
      const ragResponse = await this.orchestrator.query(
        payload.query,
        payload.aclGroup as ACLGroup
      );
      const duration = Date.now() - start;

      this.queryMetrics.recordQuery(
        duration,
        { resultCount: ragResponse.sources.length },
        this.mapQueryType(ragResponse.queryType)
      );

      const context = transformHybridContext(ragResponse.context);
      const apiResponse: ApiQueryResponse = {
        answer: ragResponse.answer,
        queryType: ragResponse.queryType,
        fallbackMode: ragResponse.fallbackMode ?? null,
        sources: ragResponse.sources,
        metadata: ragResponse.metadata,
        fusionMetrics: ragResponse.fusionMetrics,
        context,
        sTotalScore: ragResponse.sTotalScore ?? ragResponse.fusionMetrics?.avgTotalScore ?? null,
      };

      const safeResponse = this.sanitizeResponse(apiResponse);

      this.historyStore.record(
        payload.userId,
        payload.query,
        payload.aclGroup as ACLGroup,
        safeResponse
      );

      pceLogger.info("Hybrid query served", {
        queryType: ragResponse.queryType,
        aclGroup: payload.aclGroup,
        latencyMs: duration,
        sTotalScore: apiResponse.sTotalScore,
      });

      return this.jsonResponse(200, {
        success: true,
        data: safeResponse,
      });
    } catch (error: any) {
      if (error instanceof AccessDeniedError) {
        return this.jsonResponse(error.statusCode, {
          success: false,
          error: error.code,
          details: error.details,
        });
      }
      const isTransient = this.errorMetrics.isTransientError(error);
      this.errorMetrics.recordError({
        errorType: "api_query_error",
        isTransient,
        service: "api",
      });

      pceLogger.error("Hybrid query failed", { error: error.message });

      return this.jsonResponse(500, {
        success: false,
        error: "Query execution failed",
        details: error?.message,
      });
    }
  }

  private handleMetrics(): Response {
    const snapshot = this.metricsCollector.getSnapshot(60_000);
    const payload: MetricsPayload = {
      snapshot: snapshot.metrics,
      counters: pceLogger.getAllCounters(),
      timestamp: snapshot.timestamp.toISOString(),
    };

    return this.jsonResponse(200, {
      success: true,
      data: payload,
    });
  }

  /**
   * Prometheus metrics exporter endpoint
   * Returns metrics in Prometheus text format
   */
  private handlePrometheusMetrics(): Response {
    const snapshot = this.metricsCollector.getSnapshot();
    const lines: string[] = [];
    
    // Add HELP and TYPE comments for each metric
    const seenMetrics = new Set<string>();
    
    // Export all metrics in Prometheus format
    for (const [metricName, stats] of Object.entries(snapshot.metrics)) {
      // Prometheus metric names should be lowercase with underscores
      const promName = metricName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
      
      if (!seenMetrics.has(promName)) {
        lines.push(`# HELP ${promName} Palindrome PCE metric: ${metricName}`);
        lines.push(`# TYPE ${promName} gauge`);
        seenMetrics.add(promName);
      }
      
      // Export latest value (Prometheus typically uses latest/gauge)
      lines.push(`${promName} ${stats.latest}`);
      
      // Also export aggregated stats as separate metrics
      const baseName = promName.replace(/_latest$/, "");
      if (!seenMetrics.has(`${baseName}_avg`)) {
        lines.push(`# HELP ${baseName}_avg Average value for ${metricName}`);
        lines.push(`# TYPE ${baseName}_avg gauge`);
        seenMetrics.add(`${baseName}_avg`);
      }
      lines.push(`${baseName}_avg ${stats.avg}`);
      
      if (!seenMetrics.has(`${baseName}_count`)) {
        lines.push(`# HELP ${baseName}_count Count of samples for ${metricName}`);
        lines.push(`# TYPE ${baseName}_count counter`);
        seenMetrics.add(`${baseName}_count`);
      }
      lines.push(`${baseName}_count ${stats.count}`);
      
      if (!seenMetrics.has(`${baseName}_max`)) {
        lines.push(`# HELP ${baseName}_max Maximum value for ${metricName}`);
        lines.push(`# TYPE ${baseName}_max gauge`);
        seenMetrics.add(`${baseName}_max`);
      }
      lines.push(`${baseName}_max ${stats.max}`);
      
      if (!seenMetrics.has(`${baseName}_min`)) {
        lines.push(`# HELP ${baseName}_min Minimum value for ${metricName}`);
        lines.push(`# TYPE ${baseName}_min gauge`);
        seenMetrics.add(`${baseName}_min`);
      }
      lines.push(`${baseName}_min ${stats.min}`);
    }
    
    // Add system metrics
    const uptime = (Date.now() - this.startTime) / 1000;
    lines.push(`# HELP pce_api_uptime_seconds Uptime of PCE API server in seconds`);
    lines.push(`# TYPE pce_api_uptime_seconds gauge`);
    lines.push(`pce_api_uptime_seconds ${uptime}`);
    
    // Add log counters
    const counters = pceLogger.getAllCounters();
    for (const [counterName, value] of Object.entries(counters)) {
      const promName = `pce_log_${counterName.toLowerCase().replace(/[^a-z0-9_]/g, "_")}_total`;
      if (!seenMetrics.has(promName)) {
        lines.push(`# HELP ${promName} Total count of ${counterName} log events`);
        lines.push(`# TYPE ${promName} counter`);
        seenMetrics.add(promName);
      }
      lines.push(`${promName} ${value}`);
    }
    
    const prometheusText = lines.join("\n") + "\n";
    
    return new Response(prometheusText, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      },
    });
  }

  private async handleHealth(): Promise<Response> {
    const checks = await Promise.all(
      this.dependencyChecks.map(async (dep) => {
        try {
          const healthy = await dep.check();
          return {
            name: dep.name,
            healthy,
            lastChecked: new Date().toISOString(),
          };
        } catch (error: any) {
          return {
            name: dep.name,
            healthy: false,
            lastChecked: new Date().toISOString(),
            error: error?.message,
          };
        }
      })
    );

    const overallHealthy = checks.every((c) => c.healthy);
    const payload: HealthPayload = {
      status: overallHealthy ? "ok" : "degraded",
      uptimeMs: Date.now() - this.startTime,
      dependencies: checks,
    };

    return this.jsonResponse(overallHealthy ? 200 : 503, {
      success: overallHealthy,
      data: payload,
    });
  }

  private handleHistory(pathname: string): Response {
    const userId = decodeURIComponent(pathname.replace("/history/", ""));
    if (!userId) {
      return this.jsonResponse(400, {
        success: false,
        error: "User ID is required",
      });
    }

    const payload: ApiHistoryPayload = {
      userId,
      entries: this.historyStore.getHistory(userId),
    };

    return this.jsonResponse(200, {
      success: true,
      data: payload,
    });
  }

  private extractClientIp(req: Request, server: BunServer): string {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const [first] = forwarded.split(",");
      return (first ?? forwarded).trim();
    }

    const info = server.requestIP(req);
    if (info?.address) {
      return info.address;
    }

    return "unknown";
  }

  private async handleToolExecutions(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const toolName = url.searchParams.get("toolName");
      const userId = url.searchParams.get("userId");
      const aclGroup = url.searchParams.get("aclGroup") as ACLGroup | null;
      const since = url.searchParams.get("since");
      const limit = parseInt(url.searchParams.get("limit") || "100");
      const offset = parseInt(url.searchParams.get("offset") || "0");

      const { ToolExecutionStore } = await import("./tool-execution-store");
      const store = new ToolExecutionStore();
      
      const result = await store.getExecutions({
        toolName: toolName || undefined,
        userId: userId || undefined,
        aclGroup: aclGroup || undefined,
        since: since ? new Date(since) : undefined,
        limit,
        offset,
      });

      return this.jsonResponse(200, result);
    } catch (error: any) {
      pceLogger.error("Failed to fetch tool executions", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  private async handleClusterStatus(req: Request): Promise<Response> {
    try {
      // This would need to call Proxmox tools internally
      // For now, return a placeholder structure
      // TODO: Integrate with ProxmoxClient to get real cluster status
      return this.jsonResponse(200, {
        nodes: [],
        vms: [],
        alerts: [],
        message: "Cluster status endpoint - implementation pending Proxmox integration",
      });
    } catch (error: any) {
      pceLogger.error("Failed to fetch cluster status", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  private async handleOntologyGraph(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const limitParam = url.searchParams.get("limit") || "100";
      // Ensure limit is an integer, not a float
      const limitValue = Math.floor(parseInt(limitParam, 10)) || 100;
      
      // Get graph store from dependencies (if available) or create new instance
      const graphStore = new Neo4jGraphStore();
      await graphStore.connect();
      const queryInterface = new GraphQueryInterface(graphStore);
      
      // Use neo4j.int() to ensure integer type for LIMIT clause
      const { int } = await import("neo4j-driver");
      const result = await queryInterface.executeQuery(`
        MATCH (n)-[r]->(m)
        RETURN n, r, m
        LIMIT $limit
      `, { limit: int(limitValue) });

      await graphStore.close();
      
      return this.jsonResponse(200, {
        nodes: result.nodes,
        relationships: result.relationships,
        paths: result.paths,
      });
    } catch (error: any) {
      pceLogger.error("Failed to fetch ontology graph", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  private async handleDashboardRagQuery(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as {
        query?: string;
        userId?: string;
        aclGroup?: ACLGroup;
      };
      const { query, userId = "dashboard-user", aclGroup = "viewer" } = body;

      if (!query) {
        return this.jsonResponse(400, { error: "Query is required" });
      }

      // Use orchestrator directly (dashboard queries bypass rate limiting)
      const ragResponse = await this.orchestrator.query(query, aclGroup as ACLGroup);
      
      const context = transformHybridContext(ragResponse.context);
      const apiResponse: ApiQueryResponse = {
        answer: ragResponse.answer,
        queryType: ragResponse.queryType,
        fallbackMode: ragResponse.fallbackMode ?? null,
        sources: ragResponse.sources,
        metadata: ragResponse.metadata,
        fusionMetrics: ragResponse.fusionMetrics,
        context,
        sTotalScore: ragResponse.sTotalScore ?? ragResponse.fusionMetrics?.avgTotalScore ?? null,
      };

      const safeResponse = this.sanitizeResponse(apiResponse);
      
      return this.jsonResponse(200, {
        success: true,
        data: safeResponse,
      });
    } catch (error: any) {
      if (error instanceof AccessDeniedError) {
        return this.jsonResponse(error.statusCode, {
          success: false,
          error: error.code,
          details: error.details,
        });
      }
      pceLogger.error("Failed to execute RAG query", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  private async handleDashboardGraphQuery(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as {
        queryType?: string;
        param?: string;
        param2?: string;
      };
      const { queryType, param, param2 } = body;

      if (!queryType || !param) {
        return this.jsonResponse(400, { error: "queryType and param are required" });
      }

      const graphStore = new Neo4jGraphStore();
      await graphStore.connect();
      const queryInterface = new GraphQueryInterface(graphStore);

      let result;
      switch (queryType) {
        case "findByIdOrName":
          result = await queryInterface.findEntitiesByIdOrName(param);
          break;
        case "findByType":
          result = await queryInterface.getEntitiesByType(param);
          break;
        case "findByPurpose":
          result = await queryInterface.findByPurpose(param);
          break;
        case "findByRole":
          result = await queryInterface.findByRole(param);
          break;
        case "findDependencies":
          result = await queryInterface.findDependencies(param);
          break;
        case "findDependents":
          result = await queryInterface.findDependents(param);
          break;
        case "findPath":
          if (!param2) {
            await graphStore.close();
            return this.jsonResponse(400, { error: "param2 is required for findPath" });
          }
          result = await queryInterface.findPath(param, param2);
          break;
        case "findHostedEntities":
          result = await queryInterface.findHostedEntities(param);
          break;
        default:
          await graphStore.close();
          return this.jsonResponse(400, { error: `Unknown query type: ${queryType}` });
      }

      await graphStore.close();

      return this.jsonResponse(200, {
        success: true,
        data: {
          nodes: result.nodes,
          relationships: result.relationships,
          paths: result.paths,
        },
      });
    } catch (error: any) {
      pceLogger.error("Failed to execute graph query", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  private async handleDashboardCypherQuery(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as {
        cypher?: string;
        limit?: number;
      };
      const { cypher, limit = 100 } = body;

      if (!cypher) {
        return this.jsonResponse(400, { error: "Cypher query is required" });
      }

      const graphStore = new Neo4jGraphStore();
      await graphStore.connect();
      const queryInterface = new GraphQueryInterface(graphStore);

      // Use neo4j.int() for limit if provided
      const { int } = await import("neo4j-driver");
      const params: Record<string, any> = {};
      if (limit) {
        params.limit = int(Math.floor(parseInt(String(limit), 10)) || 100);
      }

      const result = await queryInterface.executeQuery(cypher, params);
      await graphStore.close();

      return this.jsonResponse(200, {
        success: true,
        data: {
          nodes: result.nodes,
          relationships: result.relationships,
          paths: result.paths,
        },
      });
    } catch (error: any) {
      pceLogger.error("Failed to execute Cypher query", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  private async handleVectorStats(req: Request): Promise<Response> {
    try {
      const vectorStore = new QdrantVectorStore();
      const collectionInfo = await vectorStore.getCollectionInfo();
      const collectionName = vectorStore.getCollectionName();
      const client = vectorStore.getClient();
      
      // Get total points count
      const totalChunks = collectionInfo.points_count || 0;
      
      // Get collection configuration
      const vectorSize = collectionInfo.config?.params?.vectors?.size || 0;
      const distance = collectionInfo.config?.params?.vectors?.distance || "unknown";
      
      // Get chunk distribution by source type and ACL group
      // Use scroll to sample chunks and analyze distribution
      const sampleSize = Math.min(1000, totalChunks); // Sample up to 1000 chunks
      const scrollResult = await client.scroll(collectionName, {
        limit: sampleSize,
        with_payload: {
          include: ["source_type", "acl_group", "timestamp", "version_hash"],
        },
        with_vector: false,
      });
      
      const points = scrollResult.points || [];
      
      // Analyze distribution
      const bySourceType: Record<string, number> = {};
      const byAclGroup: Record<string, number> = {};
      const byVersionHash: Record<string, number> = {};
      let latestTimestamp: string | null = null;
      
      for (const point of points) {
        const payload = point.payload as any;
        const sourceType = payload?.source_type || "unknown";
        const aclGroup = payload?.acl_group || "unknown";
        const versionHash = payload?.version_hash || "unknown";
        const timestamp = payload?.timestamp;
        
        bySourceType[sourceType] = (bySourceType[sourceType] || 0) + 1;
        byAclGroup[aclGroup] = (byAclGroup[aclGroup] || 0) + 1;
        byVersionHash[versionHash] = (byVersionHash[versionHash] || 0) + 1;
        
        if (timestamp && (!latestTimestamp || timestamp > latestTimestamp)) {
          latestTimestamp = timestamp;
        }
      }
      
      // Extrapolate distribution percentages (if we sampled)
      const sampleRatio = totalChunks > 0 ? points.length / totalChunks : 1;
      const distribution = {
        bySourceType: Object.fromEntries(
          Object.entries(bySourceType).map(([key, count]) => [
            key,
            {
              count: sampleRatio < 1 ? Math.round(count / sampleRatio) : count,
              percentage: points.length > 0 ? ((count / points.length) * 100).toFixed(1) : "0",
            },
          ])
        ),
        byAclGroup: Object.fromEntries(
          Object.entries(byAclGroup).map(([key, count]) => [
            key,
            {
              count: sampleRatio < 1 ? Math.round(count / sampleRatio) : count,
              percentage: points.length > 0 ? ((count / points.length) * 100).toFixed(1) : "0",
            },
          ])
        ),
        uniqueVersions: Object.keys(byVersionHash).length,
      };
      
      return this.jsonResponse(200, {
        collectionName,
        totalChunks,
        vectorSize,
        distance,
        lastIngestion: latestTimestamp,
        distribution,
        sampleSize: points.length,
        sampleRatio: sampleRatio < 1 ? (sampleRatio * 100).toFixed(1) + "%" : "100%",
      });
    } catch (error: any) {
      pceLogger.error("Failed to fetch vector stats", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  private async handleRagDiagnostics(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const query = url.searchParams.get("query");
      
      if (!query) {
        return this.jsonResponse(400, { error: "Query parameter required" });
      }

      // Run a test query and return diagnostic information
      const aclGroup = (url.searchParams.get("aclGroup") || "viewer") as ACLGroup;
      const ragResponse = await this.orchestrator.query(query, aclGroup);
      
      return this.jsonResponse(200, {
        query,
        queryType: ragResponse.queryType,
        sTotalScore: ragResponse.sTotalScore,
        fusionMetrics: ragResponse.fusionMetrics,
        sources: ragResponse.sources.map((s) => ({
          sourcePath: s.sourcePath,
          score: s.score,
          chunkId: s.chunkId,
          textPreview: s.text?.slice(0, 200),
        })),
        context: ragResponse.context
          ? {
              semanticChunks: ragResponse.context.semanticChunks.map(({ chunk, score }) => ({
                id: chunk.id,
                text: chunk.text,
                score,
                sourcePath: chunk.metadata.sourcePath,
                versionHash: chunk.metadata.versionHash,
                aclGroup: chunk.metadata.aclGroup,
                chunkIndex: chunk.metadata.chunkIndex,
                totalChunks: chunk.metadata.totalChunks,
              })),
              structuralPaths: ragResponse.context.structuralPaths,
              provenance: ragResponse.context.provenance,
            }
          : {
              semanticChunks: [],
              structuralPaths: [],
              provenance: [],
            },
      });
    } catch (error: any) {
      pceLogger.error("Failed to run RAG diagnostics", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  private async handleExecutionStats(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const since = url.searchParams.get("since");

      const { ToolExecutionStore } = await import("./tool-execution-store");
      const store = new ToolExecutionStore();
      
      const stats = await store.getExecutionStats(
        since ? new Date(since) : undefined
      );

      return this.jsonResponse(200, stats);
    } catch (error: any) {
      pceLogger.error("Failed to fetch execution stats", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  private async handleReasoningTraces(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const userId = url.searchParams.get("userId");
      const aclGroup = url.searchParams.get("aclGroup");
      const since = url.searchParams.get("since");
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const offset = parseInt(url.searchParams.get("offset") || "0");

      const { ReasoningTraceStore } = await import("./reasoning-trace-store");
      const store = new ReasoningTraceStore();
      
      const result = await store.getTraces({
        userId: userId || undefined,
        aclGroup: aclGroup || undefined,
        since: since ? new Date(since) : undefined,
        limit,
        offset,
      });

      return this.jsonResponse(200, result);
    } catch (error: any) {
      pceLogger.error("Failed to fetch reasoning traces", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  private async handleReasoningTrace(req: Request, pathname: string): Promise<Response> {
    try {
      const traceId = pathname.split("/").pop();
      if (!traceId) {
        return this.jsonResponse(400, { error: "Trace ID required" });
      }

      const { ReasoningTraceStore } = await import("./reasoning-trace-store");
      const store = new ReasoningTraceStore();
      
      const trace = await store.getTrace(traceId);
      if (!trace) {
        return this.jsonResponse(404, { error: "Trace not found" });
      }

      return this.jsonResponse(200, trace);
    } catch (error: any) {
      pceLogger.error("Failed to fetch reasoning trace", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  private mapQueryType(queryType: QueryType): "vector" | "graph" | "hybrid" {
    if (queryType === "SEMANTIC_ONLY") {
      return "vector";
    }
    if (queryType === "STRUCTURAL_PRIMARY") {
      return "graph";
    }
    return "hybrid";
  }

  private jsonResponse(status: number, body: Record<string, any>): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  private sanitizeResponse(response: ApiQueryResponse): ApiQueryResponse {
    const sanitizeText = (value?: string) =>
      typeof value === "string" ? this.redactor.redact(value).redactedText : value;

    const sanitizedSources = response.sources.map((source) => ({
      ...source,
      text: sanitizeText(source.text) ?? "",
    }));

    const sanitizedContext = response.context
      ? {
          ...response.context,
          semanticChunks: response.context.semanticChunks.map((chunk) => ({
            ...chunk,
            text: sanitizeText(chunk.text) ?? "",
          })),
        }
      : response.context;

    return {
      ...response,
      answer: sanitizeText(response.answer) ?? "",
      sources: sanitizedSources,
      context: sanitizedContext,
    };
  }
}

export interface BootstrapPceApiServerOptions extends PceApiServerOptions {
  fusionConfig?: Partial<FusionConfig>;
}

export async function bootstrapPceApiServer(options: BootstrapPceApiServerOptions = {}) {
  const { fusionConfig, ...serverOptions } = options;
  const embeddingService = new EmbeddingService();
  const vectorStore = new QdrantVectorStore();
  await vectorStore.initializeCollection(embeddingService.getDimension());

  const retrievalService = new RetrievalService(vectorStore, embeddingService);

  const graphStore = new Neo4jGraphStore();
  await graphStore.connect();
  const graphQuery = new GraphQueryInterface(graphStore);
  const graphRetrieval = new GraphRAGRetrieval(graphQuery);

  const entityResolver = new QueryEntityResolver(graphQuery);
  const analyzer = new QueryAnalyzer(entityResolver);
  const fusionEngine = new FusionEngine(fusionConfig);
  const generationService = new GenerationService();

  const orchestrator = new HybridOrchestrator(
    analyzer,
    retrievalService,
    graphRetrieval,
    fusionEngine,
    generationService
  );

  const dependencyChecks: DependencyHealthCheck[] = [
    { name: "vector_store", check: () => vectorStore.healthCheck() },
    { name: "graph_store", check: () => graphStore.healthCheck() },
  ];

  const server = new PceApiServer(
    {
      orchestrator,
      dependencyChecks,
      cleanupHandlers: [() => graphStore.close()],
    },
    serverOptions
  );

  return { server };
}
