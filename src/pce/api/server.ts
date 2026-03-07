import { z } from "zod";
import type { ACLGroup, FusionConfig, HybridRAGResponse, QueryType } from "../types";
import type { ConversationState } from "../../types";
import { pceLogger } from "../utils/logger";
import { Redactor } from "../redaction/redactor";
import { AccessDeniedError } from "../errors";
import { MetricsCollector, QueryMetrics, ErrorMetrics } from "../metrics";
import { HybridOrchestrator, QueryAnalyzer, QueryEntityResolver, FusionEngine, RetrievalService, GenerationService } from "../rag";
import { GraphRAGRetrieval } from "../graph-retrieval";
import { GraphQueryInterface, Neo4jGraphStore } from "../kg";
import { DEFAULT_COLLECTION, EmbeddingService, QdrantVectorStore } from "../vector";
import type { ApiHistoryPayload, ApiQueryResponse, DependencyHealthCheck, HealthPayload, MetricsPayload } from "./types";
import { ApiRateLimiter, type RateLimitConfig } from "./rate-limiter";
import { ContextHistoryStore } from "./history-store";
import { ChatHistoryStore } from "./chat-history-store";
import { ProfileStore, isValidPublicKeyLine } from "./profile-store";
import { PromptSuggestionStore } from "./prompt-suggestion-store";
import { PromptSuggestionService } from "./prompt-suggestion-service";
import { IngestionSummaryStore } from "./ingestion-summary-store";
import { transformHybridContext } from "./context-transformer";
import { AgentEventBus, type AgentEvent } from "../../agent/event-bus";
import { runAgent } from "../../agent/runner";
import { IngestionScheduler } from "../scheduler/ingestion-scheduler";
import { normalizeProxmoxResponse } from "../../tools/proxmox/readonly/normalization";
import { getProxmoxEndpointConfigs } from "../../tools/proxmox/config";
import { TwinQueryService } from "../../twin/api/twin-query-service";

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
  enableIngestionScheduler?: boolean;
}

export interface PceApiServerDependencies {
  orchestrator: {
    query: (query: string, aclGroup: ACLGroup) => Promise<HybridRAGResponse>;
  };
  agentRunner?: typeof runAgent;
  historyStore?: ContextHistoryStore;
  chatHistoryStore?: ChatHistoryStore;
  profileStore?: ProfileStore;
  promptSuggestionStore?: PromptSuggestionStore;
  ingestionSummaryStore?: IngestionSummaryStore;
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
  private agentRunner: typeof runAgent;
  private historyStore: ContextHistoryStore;
  private chatHistoryStore: ChatHistoryStore;
  private profileStore: ProfileStore;
  private promptSuggestionStore: PromptSuggestionStore;
  private ingestionSummaryStore: IngestionSummaryStore;
  private metricsCollector: MetricsCollector;
  private queryMetrics: QueryMetrics;
  private errorMetrics: ErrorMetrics;
  private dependencyChecks: DependencyHealthCheck[];
  private cleanupHandlers: Array<() => Promise<void> | void>;
  private rateLimiter: ApiRateLimiter;
  private ownsMetricsCollector: boolean;
  private startTime = Date.now();
  private redactor: Redactor;
  private ingestionScheduler: IngestionScheduler | null = null;

  constructor(deps: PceApiServerDependencies, options: PceApiServerOptions = {}) {
    this.options = {
      port: options.port ?? DEFAULT_OPTIONS.port,
      historyLimit: options.historyLimit ?? DEFAULT_OPTIONS.historyLimit,
      globalRateLimit: options.globalRateLimit ?? DEFAULT_OPTIONS.globalRateLimit,
      perIpRateLimit: options.perIpRateLimit ?? DEFAULT_OPTIONS.perIpRateLimit,
      enableIngestionScheduler: options.enableIngestionScheduler ?? true,
    };

    this.orchestrator = deps.orchestrator;
    this.agentRunner = deps.agentRunner ?? runAgent;
    this.historyStore = deps.historyStore ?? new ContextHistoryStore(this.options.historyLimit);
    this.chatHistoryStore = deps.chatHistoryStore ?? new ChatHistoryStore();
    this.profileStore = deps.profileStore ?? new ProfileStore();
    this.promptSuggestionStore = deps.promptSuggestionStore ?? new PromptSuggestionStore();
    this.ingestionSummaryStore = deps.ingestionSummaryStore ?? new IngestionSummaryStore();
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

    // Start ingestion scheduler (runs every 5 minutes)
    if (this.options.enableIngestionScheduler !== false && !this.ingestionScheduler) {
      this.ingestionScheduler = new IngestionScheduler(5, this.metricsCollector); // 5 minutes, pass metrics collector
      this.ingestionScheduler.start();
      pceLogger.info("Ingestion scheduler started (every 5 minutes)");
    }

    // HTTP server
    this.server = Bun.serve({
      hostname: "0.0.0.0", // Bind to all interfaces (IPv4) for Docker access
      port: this.options.port,
      fetch: (req, server) => this.handleRequest(req, server),
      idleTimeout: 255, // Maximum allowed (4.25 minutes) for long-running agent queries
    });

    pceLogger.info("PCE API server started", {
      port: this.server.port,
      url: `http://localhost:${this.server.port}`,
    });

    // HTTPS server (optional, if certs exist and port is not 0)
    // Skip HTTPS when port is 0 (random port) to avoid permission issues
    if (this.options.port !== 0) {
      const certPath = `${process.cwd()}/certs/cert.pem`;
      const keyPath = `${process.cwd()}/certs/key.pem`;
      const certFile = Bun.file(certPath);
      const keyFile = Bun.file(keyPath);
      
      if (await certFile.exists() && await keyFile.exists()) {
        const httpsPort = this.options.port + 443; // 4000 -> 4443
        Bun.serve({
          hostname: "0.0.0.0",
          port: httpsPort,
          fetch: (req, server) => this.handleRequest(req, server),
          idleTimeout: 255,
          tls: {
            cert: certFile,
            key: keyFile,
          },
        });
        pceLogger.info("PCE API HTTPS server started", {
          port: httpsPort,
          url: `https://localhost:${httpsPort}`,
        });
      }
    }
  }

  async stop(): Promise<void> {
    // Stop ingestion scheduler
    if (this.ingestionScheduler) {
      this.ingestionScheduler.stop();
      this.ingestionScheduler = null;
      pceLogger.info("Ingestion scheduler stopped");
    }

    if (this.server) {
      this.server.stop();
      this.server = null;
      pceLogger.info("PCE API server stopped");
    }

    if (this.ownsMetricsCollector) {
      this.metricsCollector.shutdown();
    }

    try {
      this.promptSuggestionStore.close();
    } catch (error: any) {
      pceLogger.warn("Failed to close prompt suggestion store", { error: error.message });
    }

    try {
      this.ingestionSummaryStore.close();
    } catch (error: any) {
      pceLogger.warn("Failed to close ingestion summary store", { error: error.message });
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
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
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

    if (req.method === "GET" && url.pathname === "/api/dashboard/prompt-suggestions") {
      return await this.handlePromptSuggestions(req);
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard/twin-summary") {
      return await this.handleTwinSummary(req);
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

    if (req.method === "GET" && url.pathname === "/api/dashboard/ingestion-status") {
      return await this.handleIngestionStatus(req);
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard/ingestion-summaries") {
      return await this.handleIngestionSummaries(req);
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

    // Agent streaming endpoint (SSE)
    if (req.method === "GET" && url.pathname === "/api/agent/stream") {
      return await this.handleAgentStream(req);
    }

    // Agent query endpoint (triggers agent with tool calling)
    if (req.method === "POST" && url.pathname === "/api/agent/query") {
      return await this.handleAgentQuery(req);
    }

    // Chat history endpoints
    if (req.method === "GET" && url.pathname === "/api/chat/history") {
      return await this.handleGetChatHistory(req);
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/chat/history/") && !url.pathname.includes("/conversations/")) {
      return await this.handleDeleteChatMessage(req, url);
    }

    // Conversation endpoints
    if (req.method === "GET" && url.pathname === "/api/chat/conversations") {
      return await this.handleGetConversations(req);
    }

    if (req.method === "POST" && url.pathname === "/api/chat/conversations") {
      return await this.handleCreateConversation(req);
    }

    if (req.method === "POST" && url.pathname === "/api/chat/clarification-responses") {
      return await this.handleClarificationResponse(req);
    }

    if (req.method === "DELETE" && url.pathname === "/api/chat/conversations") {
      return await this.handleDeleteAllConversations(req);
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/chat/conversations/") && url.pathname.endsWith("/messages")) {
      return await this.handleGetConversationMessages(req, url);
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/chat/conversations/") && !url.pathname.endsWith("/messages")) {
      return await this.handleDeleteConversation(req, url);
    }

    if (req.method === "PATCH" && url.pathname.startsWith("/api/chat/conversations/")) {
      return await this.handleUpdateConversationTitle(req, url);
    }

    // User preferences endpoints
    if (req.method === "GET" && url.pathname === "/api/user/preferences") {
      return await this.handleGetUserPreferences(req);
    }

    if (req.method === "PUT" && url.pathname === "/api/user/preferences") {
      return await this.handleSetUserPreferences(req);
    }

    if (req.method === "GET" && url.pathname === "/api/user/profile") {
      return await this.handleGetUserProfile(req);
    }

    if (req.method === "PUT" && url.pathname === "/api/user/profile") {
      return await this.handleSetUserProfile(req);
    }

    if (req.method === "GET" && url.pathname === "/api/user/profiles") {
      return await this.handleListProfiles(req);
    }

    if (req.method === "DELETE" && url.pathname === "/api/user/profile") {
      return await this.handleDeleteProfile(req);
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

      this.metricsCollector.record("api_http_requests_total", 1, {
        route: "/query",
        method: "POST",
        status: "429",
      });

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
      this.metricsCollector.record("api_http_requests_total", 1, {
        route: "/query",
        method: "POST",
        status: "400",
      });

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

      this.metricsCollector.record("api_http_requests_total", 1, {
        route: "/query",
        method: "POST",
        status: "200",
      });
      this.metricsCollector.record("api_http_request_duration_ms", duration, {
        route: "/query",
        method: "POST",
        status: "200",
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

      const errorDuration = Date.now() - start;
      this.metricsCollector.record("api_http_requests_total", 1, {
        route: "/query",
        method: "POST",
        status: "500",
      });
      this.metricsCollector.record("api_http_request_duration_ms", errorDuration, {
        route: "/query",
        method: "POST",
        status: "500",
      });

      return this.jsonResponse(500, {
        success: false,
        error: "Query execution failed",
        details: error?.message,
      });
    }
  }

  private handleMetrics(): Response {
    const requestStart = Date.now();
    this.metricsCollector.record("api_http_requests_total", 1, {
      route: "/metrics",
      method: "GET",
      format: "json",
      status: "200",
    });

    const snapshot = this.metricsCollector.getSnapshot(60_000);
    const payload: MetricsPayload = {
      snapshot: snapshot.metrics,
      counters: pceLogger.getAllCounters(),
      timestamp: snapshot.timestamp.toISOString(),
    };
    this.metricsCollector.record("api_http_request_duration_ms", Date.now() - requestStart, {
      route: "/metrics",
      method: "GET",
      format: "json",
      status: "200",
    });

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
    const requestStart = Date.now();
    this.metricsCollector.record("api_http_requests_total", 1, {
      route: "/metrics",
      method: "GET",
      format: "prometheus",
      status: "200",
    });

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
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    const seriesCount = Object.keys(snapshot.metrics).length;
    const exportTimestampSeconds = Math.floor(Date.now() / 1000);
    lines.push(`# HELP pce_api_uptime_seconds Uptime of PCE API server in seconds`);
    lines.push(`# TYPE pce_api_uptime_seconds gauge`);
    lines.push(`pce_api_uptime_seconds ${uptime}`);
    lines.push(`# HELP pce_metrics_series_count Number of metric series currently present in the in-memory collector snapshot`);
    lines.push(`# TYPE pce_metrics_series_count gauge`);
    lines.push(`pce_metrics_series_count ${seriesCount}`);
    lines.push(`# HELP pce_metrics_export_timestamp_seconds Unix timestamp when metrics were exported`);
    lines.push(`# TYPE pce_metrics_export_timestamp_seconds gauge`);
    lines.push(`pce_metrics_export_timestamp_seconds ${exportTimestampSeconds}`);
    lines.push(`# HELP pce_process_resident_memory_bytes Resident set size of the PCE API process`);
    lines.push(`# TYPE pce_process_resident_memory_bytes gauge`);
    lines.push(`pce_process_resident_memory_bytes ${memoryUsage.rss}`);
    lines.push(`# HELP pce_process_heap_total_bytes Total V8 heap size for the PCE API process`);
    lines.push(`# TYPE pce_process_heap_total_bytes gauge`);
    lines.push(`pce_process_heap_total_bytes ${memoryUsage.heapTotal}`);
    lines.push(`# HELP pce_process_heap_used_bytes Used V8 heap size for the PCE API process`);
    lines.push(`# TYPE pce_process_heap_used_bytes gauge`);
    lines.push(`pce_process_heap_used_bytes ${memoryUsage.heapUsed}`);
    lines.push(`# HELP pce_process_cpu_user_seconds_total Total user CPU time consumed by the PCE API process`);
    lines.push(`# TYPE pce_process_cpu_user_seconds_total counter`);
    lines.push(`pce_process_cpu_user_seconds_total ${cpuUsage.user / 1_000_000}`);
    lines.push(`# HELP pce_process_cpu_system_seconds_total Total system CPU time consumed by the PCE API process`);
    lines.push(`# TYPE pce_process_cpu_system_seconds_total counter`);
    lines.push(`pce_process_cpu_system_seconds_total ${cpuUsage.system / 1_000_000}`);
    
    // Add log counters
    const counters = pceLogger.getAllCounters();
    for (const [counterName, value] of Object.entries(counters)) {
      const sanitizedCounter = counterName.toLowerCase().replace(/[^a-z0-9_]/g, "_");
      const promName = sanitizedCounter.endsWith("_total")
        ? `pce_log_${sanitizedCounter}`
        : `pce_log_${sanitizedCounter}_total`;
      if (!seenMetrics.has(promName)) {
        lines.push(`# HELP ${promName} Total count of ${counterName} log events`);
        lines.push(`# TYPE ${promName} counter`);
        seenMetrics.add(promName);
      }
      lines.push(`${promName} ${value}`);
    }
    
    const prometheusText = lines.join("\n") + "\n";
    this.metricsCollector.record("api_http_request_duration_ms", Date.now() - requestStart, {
      route: "/metrics",
      method: "GET",
      format: "prometheus",
      status: "200",
    });
    
    return new Response(prometheusText, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      },
    });
  }

  private async handleHealth(): Promise<Response> {
    const healthRequestStart = Date.now();
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
    const configs = getProxmoxEndpointConfigs();
    const payload: HealthPayload = {
      status: overallHealthy ? "ok" : "degraded",
      uptimeMs: Date.now() - this.startTime,
      dependencies: checks,
      proxmoxEndpoints: { count: configs.length, labels: configs.map((c) => c.label) },
    };

    this.metricsCollector.record("api_http_requests_total", 1, {
      route: "/health",
      method: "GET",
      status: overallHealthy ? "200" : "503",
    });
    this.metricsCollector.record("api_http_request_duration_ms", Date.now() - healthRequestStart, {
      route: "/health",
      method: "GET",
      status: overallHealthy ? "200" : "503",
    });

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
      // Check if Proxmox environment variables are set
      const proxmoxUrl = process.env.PROXMOX_URL;
      // Support both legacy API token vars and newer cluster TF token vars.
      const proxmoxTokenId =
        process.env.PROXMOX_TOKEN_ID ||
        process.env.PROXMOX_API_TOKEN_ID ||
        process.env.CLUSTER_TF_TOKEN_ID ||
        process.env.PROXBIG_TF_TOKEN_ID;
      const proxmoxTokenSecret =
        process.env.PROXMOX_TOKEN_SECRET ||
        process.env.PROXMOX_API_TOKEN_SECRET ||
        process.env.PROXMOX_CLUSTER_TF_SECRET ||
        process.env.PROXBIG_TOKEN_SECRET ||
        process.env.PROXBIG_TF_SECRET ||
        process.env.PROXMOX_PROXBIG_TF_SECRET;

      if (!proxmoxUrl || !proxmoxTokenId || !proxmoxTokenSecret) {
        return this.jsonResponse(200, {
          nodes: [],
          vms: [],
          lxc: [],
          alerts: [],
          message: "Proxmox not configured (missing environment variables)",
        });
      }

      // Import Proxmox tools dynamically to avoid circular dependencies
      const { ProxmoxClient } = await import("../../tools/proxmox/client");
      const { ProxmoxReadOnlyTool } = await import("../../tools/proxmox/readonly/proxmox-readonly-tool");

      const verifySsl = process.env.PROXMOX_VERIFY_SSL !== "false";

      // Create Proxmox client (primary)
      const client = new ProxmoxClient({
        url: proxmoxUrl,
        tokenId: proxmoxTokenId,
        tokenSecret: proxmoxTokenSecret,
        verifySsl,
      });

      const tool = new ProxmoxReadOnlyTool();
      const context = { toolName: "proxmox_readonly", startedAt: Date.now() };

      // Fetch cluster data in parallel
      const [nodesResult, clusterStatusResult, resourcesResult] = await Promise.all([
        tool.execute({ action: "list_nodes" }, context),
        tool.execute({ action: "cluster_status" }, context),
        tool.execute({ action: "cluster_resources" }, context),
      ]);

      // Handle errors gracefully
      if (nodesResult.error) {
        pceLogger.warn("Failed to fetch nodes for cluster status", { error: nodesResult.error });
      }
      if (clusterStatusResult.error) {
        pceLogger.warn("Failed to fetch cluster status", { error: clusterStatusResult.error });
      }
      if (resourcesResult.error) {
        pceLogger.warn("Failed to fetch cluster resources", { error: resourcesResult.error });
      }

      const nodes = nodesResult.data?.nodes || [];
      const clusterStatus = clusterStatusResult.data || {};
      const primaryResources = resourcesResult.data?.resources || [];

      // Attempt to pull compute resources from other configured endpoints (yin/yang) if present.
      // This helps when PROXMOX_URL points at an API that doesn't surface all LXCs due to token scoping.
      const fetchExtraResources = async (): Promise<any[]> => {
        const endpoints: Array<{ label: string; url?: string; tokenId?: string; tokenSecret?: string }> = [
          {
            label: "yin",
            url: process.env.PROXMOX_YIN_URL,
            tokenId:
              process.env.PROXMOX_YIN_TF_TOKEN_ID ||
              process.env.CLUSTER_TF_TOKEN_ID ||
              process.env.PROXMOX_YIN_TOKEN_ID ||
              process.env.PROXMOX_TOKEN_ID ||
              process.env.PROXMOX_API_TOKEN_ID,
            tokenSecret:
              process.env.PROXMOX_YIN_TF_SECRET ||
              process.env.YIN_TOKEN_SECRET ||
              process.env.PROXMOX_CLUSTER_TF_SECRET ||
              process.env.PROXMOX_TOKEN_SECRET ||
              process.env.PROXMOX_API_TOKEN_SECRET,
          },
          {
            label: "yang",
            url: process.env.PROXMOX_YANG_URL,
            tokenId:
              process.env.PROXMOX_YANG_TF_TOKEN_ID ||
              process.env.CLUSTER_TF_TOKEN_ID ||
              process.env.PROXMOX_YANG_TOKEN_ID ||
              process.env.PROXMOX_TOKEN_ID ||
              process.env.PROXMOX_API_TOKEN_ID,
            tokenSecret:
              process.env.PROXMOX_YANG_TF_SECRET ||
              process.env.YANG_TOKEN_SECRET ||
              process.env.PROXMOX_CLUSTER_TF_SECRET ||
              process.env.PROXMOX_TOKEN_SECRET ||
              process.env.PROXMOX_API_TOKEN_SECRET,
          },
        ];

        const primaryBase = proxmoxUrl?.replace(/\/api2\/json\/?$/, "").replace(/\/$/, "");
        const seenBaseUrls = new Set<string>([primaryBase || ""]);
        const combined: any[] = [];

        for (const ep of endpoints) {
          if (!ep.url || !ep.tokenId || !ep.tokenSecret) continue;
          const base = ep.url.replace(/\/api2\/json\/?$/, "").replace(/\/$/, "");
          if (seenBaseUrls.has(base)) continue;
          seenBaseUrls.add(base);

          try {
            const altClient = new ProxmoxClient({
              url: ep.url,
              tokenId: ep.tokenId,
              tokenSecret: ep.tokenSecret,
              verifySsl,
            });

            // 1) Prefer /cluster/resources (single call, includes both qemu + lxc)
            const clusterRes = await altClient.get("/cluster/resources");
            const all = (clusterRes.data as any)?.data || [];
            const filtered = Array.isArray(all) ? all.filter((r: any) => r?.type === "qemu" || r?.type === "lxc") : [];
            if (filtered.length) {
              combined.push(
                ...filtered.map((resource: any) =>
                  normalizeProxmoxResponse({
                    id: resource.id,
                    type: resource.type,
                    node: resource.node,
                    name: resource.name,
                    status: resource.status,
                    cpu: resource.cpu,
                    mem: resource.mem,
                    maxmem: resource.maxmem,
                    maxdisk: resource.maxdisk,
                    disk: resource.disk,
                    uptime: resource.uptime,
                    vmid: resource.vmid,
                  })
                )
              );
              continue;
            }

            // 2) Fallback: per-node LXC listing (some token scopes can see /nodes/*/lxc even if cluster resources is filtered)
            const nodesRes = await altClient.get("/nodes");
            const altNodes = Array.isArray((nodesRes.data as any)?.data) ? (nodesRes.data as any).data : [];
            for (const n of altNodes) {
              const nodeName = n?.node;
              if (!nodeName) continue;
              try {
                const lxcRes = await altClient.get(`/nodes/${nodeName}/lxc`);
                const lxcs = Array.isArray((lxcRes.data as any)?.data) ? (lxcRes.data as any).data : [];
                combined.push(
                  ...lxcs.map((ct: any) =>
                    normalizeProxmoxResponse({
                      id: ct.id ? `lxc/${ct.id}` : `lxc/${ct.vmid}`,
                      type: "lxc",
                      node: nodeName,
                      name: ct.name,
                      status: ct.status,
                      cpu: ct.cpu,
                      mem: ct.mem,
                      maxmem: ct.maxmem,
                      maxdisk: ct.maxdisk,
                      disk: ct.disk,
                      uptime: ct.uptime,
                      vmid: ct.vmid,
                    })
                  )
                );
              } catch {
                // ignore per-node failures
              }
            }
          } catch {
            // ignore alternative endpoint failures
          }
        }

        return combined;
      };

      const extraResources = await fetchExtraResources();

      // Merge primary + extra resources (dedupe by id)
      const mergedResources = (() => {
        const byId = new Map<string, any>();
        const add = (arr: any[]) => {
          for (const r of arr) {
            const key = String(r?.id || `${r?.type || "unknown"}/${r?.vmid || "na"}/${r?.node || "na"}`);
            if (!byId.has(key)) byId.set(key, r);
          }
        };
        add(primaryResources);
        add(extraResources);
        return Array.from(byId.values());
      })();

      // Only count compute resources (qemu + lxc). cluster_resources can include nodes/storage too.
      const computeResources = mergedResources.filter((r: any) => r?.type === "qemu" || r?.type === "lxc");
      const vmResources = computeResources.filter((r: any) => r?.type === "qemu");
      const lxcResources = computeResources.filter((r: any) => r?.type === "lxc");

      // Determine if this is a cluster or standalone node
      const isCluster = nodes.length > 1;
      
      // Only include quorum for clusters (standalone nodes don't have quorum)
      let quorum = null;
      if (isCluster && clusterStatus.quorum) {
        quorum = clusterStatus.quorum;
      }

      // Aggregate compute statistics
      const runningVms = vmResources.filter((r: any) => r.status === "running");
      const stoppedVms = vmResources.filter((r: any) => r.status === "stopped");
      const totalVms = vmResources.length;

      const runningLxc = lxcResources.filter((r: any) => r.status === "running");
      const stoppedLxc = lxcResources.filter((r: any) => r.status === "stopped");
      const totalLxc = lxcResources.length;

      // Aggregate node statistics
      const onlineNodes = nodes.filter((n: any) => n.status_normalized === "online" || n.status === "online");
      const offlineNodes = nodes.filter((n: any) => n.status_normalized === "offline" || n.status === "offline");

      return this.jsonResponse(200, {
        isCluster,
        quorum,
        nodes: {
          total: nodes.length,
          online: onlineNodes.length,
          offline: offlineNodes.length,
          list: nodes.map((n: any) => ({
            name: n.node,
            status: n.status_normalized || n.status,
            cpu: n.cpu,
            memory: n.mem_normalized || n.mem,
            uptime: n.uptime,
          })),
        },
        vms: {
          total: totalVms,
          running: runningVms.length,
          stopped: stoppedVms.length,
          resources: vmResources.slice(0, 50), // Limit to first 50 for performance
        },
        lxc: {
          total: totalLxc,
          running: runningLxc.length,
          stopped: stoppedLxc.length,
          resources: lxcResources.slice(0, 50),
        },
        alerts: [], // TODO: Implement alert detection
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      pceLogger.error("Failed to fetch cluster status", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  private async handleOntologyGraph(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const limitParam = url.searchParams.get("limit") || "300";
      // Ensure limit is an integer, not a float
      const limitValue = Math.floor(parseInt(limitParam, 10)) || 300;
      const defaultGraphTypes = [
        "compute_vm",
        "compute_node",
        "network_interface",
        "network_subnet",
        "storage",
        "firewall_rule",
      ];
      const requestedTypes = url.searchParams
        .get("types")
        ?.split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      const graphTypes = requestedTypes?.length ? requestedTypes : defaultGraphTypes;
      
      // Get graph store from dependencies (if available) or create new instance
      const graphStore = new Neo4jGraphStore();
      await graphStore.connect();
      const queryInterface = new GraphQueryInterface(graphStore);
      
      // Use neo4j.int() to ensure integer type for LIMIT clause
      const { int } = await import("neo4j-driver");
      
      // Fetch up to N ontology nodes first, then optionally include their outgoing
      // relationships. This preserves isolated nodes (e.g. interfaces without
      // subnet links yet) so the graph view reflects full store contents.
      const result = await queryInterface.executeQuery(`
        MATCH (n:TwinEntity)
        WHERE toLower(coalesce(n.type, "")) IN $types
        WITH n
        ORDER BY coalesce(n.displayName, n.id)
        LIMIT $limit
        WITH collect(n) AS selectedNodes
        UNWIND selectedNodes AS n
        OPTIONAL MATCH (n)-[r]->(m:TwinEntity)
        WHERE m IN selectedNodes
        RETURN n, r, m
      `, { limit: int(limitValue), types: graphTypes });

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
      const sinceParam = url.searchParams.get("since");
      const defaultSinceMs = 7 * 24 * 60 * 60 * 1000;
      const since = sinceParam ? new Date(sinceParam) : new Date(Date.now() - defaultSinceMs);
      const usedDefaultWindow = !sinceParam;

      const { ToolExecutionStore } = await import("./tool-execution-store");
      const store = new ToolExecutionStore();

      const stats = await store.getExecutionStats(since);

      // Add ingestion scheduler metrics
      const ingestionMetrics = this.getIngestionSchedulerMetrics();
      const metricsSnapshot = this.metricsCollector.getSnapshot(300_000); // Last 5 minutes
      
      // Extract ingestion scheduler metrics from snapshot
      const ingestionRunCount = metricsSnapshot.metrics["ingestion_scheduler_run_count"]?.latest || 0;
      const ingestionSuccessCount = metricsSnapshot.metrics["ingestion_scheduler_success_count"]?.latest || 0;
      const ingestionFailureCount = metricsSnapshot.metrics["ingestion_scheduler_failure_count"]?.latest || 0;
      const ingestionAvgDuration = metricsSnapshot.metrics["ingestion_scheduler_run_duration_ms"]?.avg || 0;
      const proxmoxAvgDuration = metricsSnapshot.metrics["ingestion_scheduler_proxmox_duration_ms"]?.avg || 0;
      const networkAvgDuration = metricsSnapshot.metrics["ingestion_scheduler_network_duration_ms"]?.avg || 0;
      const firewallAvgDuration = metricsSnapshot.metrics["ingestion_scheduler_firewall_duration_ms"]?.avg || 0;

      return this.jsonResponse(200, {
        ...stats,
        window: usedDefaultWindow ? "7d" : undefined,
        ingestion: {
          ...ingestionMetrics,
          runCount: ingestionRunCount,
          successCount: ingestionSuccessCount,
          failureCount: ingestionFailureCount,
          successRate: ingestionRunCount > 0 ? (ingestionSuccessCount / ingestionRunCount) * 100 : 0,
          avgDurationMs: ingestionAvgDuration,
          proxmoxAvgDurationMs: proxmoxAvgDuration,
          networkAvgDurationMs: networkAvgDuration,
          firewallAvgDurationMs: firewallAvgDuration,
        },
      });
    } catch (error: any) {
      pceLogger.error("Failed to fetch execution stats", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  /**
   * Get ingestion scheduler metrics
   */
  private getIngestionSchedulerMetrics() {
    if (!this.ingestionScheduler) {
      return {
        active: false,
        lastRun: null,
        intervalMinutes: 0,
      };
    }

    return {
      active: this.ingestionScheduler.isActive(),
      lastRun: this.ingestionScheduler.getLastRun()?.toISOString() || null,
      intervalMinutes: 5,
    };
  }

  /**
   * Handle GET /api/dashboard/ingestion-status - Get detailed ingestion status
   */
  private async handleIngestionStatus(req: Request): Promise<Response> {
    try {
      if (!this.ingestionScheduler) {
        return this.jsonResponse(200, {
          active: false,
          message: "Ingestion scheduler not initialized",
        });
      }

      const lastRunDetails = this.ingestionScheduler.getLastRunDetails();
      const runHistory = this.ingestionScheduler.getRunHistory(10);
      const isRunning = this.ingestionScheduler.getIsRunning();
      const lastRun = this.ingestionScheduler.getLastRun();
      const metricsSnapshot = this.metricsCollector.getSnapshot(300_000); // Last 5 minutes

      // Calculate next run time
      const intervalMs = 5 * 60 * 1000; // 5 minutes
      const nextRun = lastRun 
        ? new Date(lastRun.getTime() + intervalMs)
        : null;

      // Get metrics
      const runCount = metricsSnapshot.metrics["ingestion_scheduler_run_count"]?.latest || 0;
      const successCount = metricsSnapshot.metrics["ingestion_scheduler_success_count"]?.latest || 0;
      const failureCount = metricsSnapshot.metrics["ingestion_scheduler_failure_count"]?.latest || 0;
      const avgDuration = metricsSnapshot.metrics["ingestion_scheduler_run_duration_ms"]?.avg || 0;
      const proxmoxAvgDuration = metricsSnapshot.metrics["ingestion_scheduler_proxmox_duration_ms"]?.avg || 0;
      const networkAvgDuration = metricsSnapshot.metrics["ingestion_scheduler_network_duration_ms"]?.avg || 0;
      const firewallAvgDuration = metricsSnapshot.metrics["ingestion_scheduler_firewall_duration_ms"]?.avg || 0;
      const cleanupDeleted = metricsSnapshot.metrics["ingestion_scheduler_cleanup_deleted"]?.latest || 0;

      return this.jsonResponse(200, {
        active: this.ingestionScheduler.isActive(),
        isRunning,
        intervalMinutes: 5,
        lastRun: lastRun?.toISOString() || null,
        nextRun: nextRun?.toISOString() || null,
        lastRunDetails: lastRunDetails ? {
          timestamp: lastRunDetails.timestamp.toISOString(),
          duration: lastRunDetails.duration,
          success: lastRunDetails.success,
          proxmox: lastRunDetails.proxmox,
          network: lastRunDetails.network,
          firewall: lastRunDetails.firewall,
          cleanup: lastRunDetails.cleanup,
          temperature: lastRunDetails.temperature,
        } : null,
        runHistory: runHistory.map(run => ({
          timestamp: run.timestamp.toISOString(),
          duration: run.duration,
          success: run.success,
          proxmox: { success: run.proxmox.success, duration: run.proxmox.duration, error: run.proxmox.error },
          network: { 
            success: run.network.success, 
            duration: run.network.duration, 
            entities: run.network.entities,
            relationships: run.network.relationships,
            error: run.network.error 
          },
          firewall: { 
            success: run.firewall.success, 
            duration: run.firewall.duration, 
            entities: run.firewall.entities,
            relationships: run.firewall.relationships,
            error: run.firewall.error 
          },
          cleanup: run.cleanup,
          temperature: run.temperature,
        })),
        statistics: {
          totalRuns: runCount,
          successCount,
          failureCount,
          successRate: runCount > 0 ? (successCount / runCount) * 100 : 0,
          avgDurationMs: avgDuration,
          proxmoxAvgDurationMs: proxmoxAvgDuration,
          networkAvgDurationMs: networkAvgDuration,
          firewallAvgDurationMs: firewallAvgDuration,
          totalCleanupDeleted: cleanupDeleted,
        },
      });
    } catch (error: any) {
      pceLogger.error("Failed to fetch ingestion status", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  private async handleIngestionSummaries(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const queryParse = z
        .object({
          limit: z.coerce.number().int().min(1).max(50).optional(),
        })
        .safeParse({ limit: url.searchParams.get("limit") });

      if (!queryParse.success) {
        return this.jsonResponse(400, { error: "Invalid limit parameter" });
      }

      const limit = queryParse.data.limit ?? 5;
      const summaries = await this.ingestionSummaryStore.listSummaries(limit);
      return this.jsonResponse(200, { data: summaries });
    } catch (error: any) {
      pceLogger.error("Failed to fetch ingestion summaries", { error: error.message });
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

      const url = new URL(req.url);
      const includeArtifacts = url.searchParams.get("includeArtifacts") === "1";
      const { ReasoningTraceStore } = await import("./reasoning-trace-store");
      const store = new ReasoningTraceStore();
      
      const trace = await store.getTrace(traceId, { includeArtifacts });
      if (!trace) {
        return this.jsonResponse(404, { error: "Trace not found" });
      }

      return this.jsonResponse(200, trace);
    } catch (error: any) {
      pceLogger.error("Failed to fetch reasoning trace", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  private async handlePromptSuggestions(req: Request): Promise<Response> {
    try {
      const requestUrl = new URL(req.url);
      const refreshParam = (requestUrl.searchParams.get("refresh") || "").toLowerCase();
      const forceRefresh =
        refreshParam === "1" || refreshParam === "true" || refreshParam === "yes";
      const refreshSeed =
        requestUrl.searchParams.get("seed") ||
        requestUrl.searchParams.get("ts") ||
        undefined;

      if (!forceRefresh) {
        const latest = await this.promptSuggestionStore.getLatestBatch();
        if (latest) {
          return this.jsonResponse(200, { data: latest, meta: { source: "cache" } });
        }
      }

      const generator = new PromptSuggestionService({
        store: this.promptSuggestionStore,
        refreshSeed,
      });
      const generated = await generator.generateAndStore();
      return this.jsonResponse(200, {
        data: generated,
        meta: { source: forceRefresh ? "refreshed" : "generated" },
      });
    } catch (error: any) {
      pceLogger.error("Failed to fetch prompt suggestions", { error: error.message });
      return this.jsonResponse(200, { data: null, error: "prompt_suggestions_unavailable" });
    }
  }

  private async handleTwinSummary(_req: Request): Promise<Response> {
    const twinQuery = new TwinQueryService();
    try {
      const { nodes, vms } = await twinQuery.describeCluster(null);
      const firewallRules = await twinQuery.listFirewallRules();
      const interfaces = await twinQuery.listInterfaces();

      return this.jsonResponse(200, {
        data: {
          nodes,
          vms,
          counts: {
            nodes: nodes.length,
            vms: vms.length,
            firewallRules: firewallRules.length,
            interfaces: interfaces.length,
          },
        },
      });
    } catch (error: any) {
      pceLogger.error("Failed to fetch twin summary", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    } finally {
      await twinQuery.close();
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
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
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

  /**
   * Handle agent query (triggers agent execution)
   */
  private async handleAgentQuery(req: Request): Promise<Response> {
    try {
      const body = await req.json() as {
        query?: string;
        userId?: string;
        profileUserId?: string;
        aclGroup?: string;
        sessionId?: string;
        conversationId?: string;
      };

      if (!body.query) {
        return this.jsonResponse(400, { error: "Query is required" });
      }

      const userId = body.userId || "dashboard-user";
      const profileUserId = body.profileUserId || userId;
      const aclGroup = (body.aclGroup || "admin") as ACLGroup;
      const sessionId = body.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const conversationId = body.conversationId || null;

      // Get or create conversation
      let activeConversationId = conversationId;
      if (!activeConversationId) {
        // Create new conversation
        try {
          activeConversationId = await this.chatHistoryStore.createConversation(userId);
        } catch (error: any) {
          pceLogger.warn("Failed to create conversation", { error: error.message });
        }
      }

      // Load conversation history for context
      let conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
      let conversationState: ConversationState = "IDLE";
      let conversationContext = {};
      let userPreferences = {};
      if (activeConversationId) {
        try {
          const messages = await this.chatHistoryStore.getHistory({
            conversationId: activeConversationId,
            userId,
            limit: 50, // Last 50 messages for context
          });
          conversationHistory = messages.map(msg => ({
            role: msg.role,
            content: msg.content,
          }));
          const conversation = await this.chatHistoryStore.getConversation(activeConversationId, userId);
          conversationState = conversation?.state || "IDLE";
          conversationContext = await this.chatHistoryStore.getConversationContext(activeConversationId);
        } catch (error: any) {
          pceLogger.warn("Failed to load conversation history", { error: error.message });
        }
      }
      try {
        userPreferences = await this.chatHistoryStore.getUserPreferences(userId);
      } catch (error: any) {
        pceLogger.warn("Failed to load user preferences", { error: error.message });
      }

      // Save user message to chat history
      if (activeConversationId) {
        try {
          await this.chatHistoryStore.saveMessage({
            conversationId: activeConversationId,
            userId,
            aclGroup,
            role: "user",
            content: body.query,
            timestamp: new Date(),
          });
        } catch (error: any) {
          pceLogger.warn("Failed to save user message to chat history", { error: error.message });
        }
      }

      // Subscribe to agent:final event to save assistant response
      const eventBus = AgentEventBus.getInstance();
      const unsubscribe = eventBus.onType("agent:final", async (event: AgentEvent) => {
        const finalData = event.data;
        if (finalData.type !== "agent:final") {
          return;
        }
        if (event.sessionId === sessionId && finalData.text && activeConversationId) {
          try {
            await this.chatHistoryStore.saveMessage({
              conversationId: activeConversationId,
              userId,
              aclGroup,
              role: "assistant",
              content: finalData.text,
              timestamp: new Date(event.timestamp),
              reasoningTraceId: finalData.traceId,
            });

            if (finalData.conversationState) {
              await this.chatHistoryStore.updateConversationState(
                activeConversationId,
                finalData.conversationState as ConversationState,
                userId
              );
            }
            if (finalData.conversationContext) {
              const rawSource = finalData.memorySource as string | undefined;
              const allowedSources = new Set(["user_explicit", "policy_inference", "tool_verified"]);
              const memorySource = allowedSources.has(rawSource ?? "")
                ? (rawSource as "user_explicit" | "policy_inference" | "tool_verified")
                : "policy_inference";
              const rawConfidence = finalData.memoryConfidence as number | undefined;
              const memoryConfidence = Number.isFinite(rawConfidence)
                ? Math.min(1, Math.max(0, rawConfidence as number))
                : 0.7;
              await this.chatHistoryStore.setConversationContext(
                activeConversationId,
                finalData.conversationContext,
                memorySource,
                memoryConfidence,
                userId
              );
            }
            
            // Auto-generate conversation title from first user message if still default
            const conv = await this.chatHistoryStore.getConversation(activeConversationId);
            if (conv && conv.title.startsWith("Chat ")) {
              // Generate title from first user message (first 50 chars)
              const firstMessages = await this.chatHistoryStore.getHistory({
                conversationId: activeConversationId,
                limit: 1,
              });
              const firstMessage = firstMessages[0];
              if (firstMessage && firstMessage.role === "user") {
                const title = firstMessage.content.substring(0, 50).trim();
                if (title) {
                  await this.chatHistoryStore.updateConversationTitle(activeConversationId, title);
                }
              }
            }
          } catch (error: any) {
            pceLogger.warn("Failed to save assistant message to chat history", { error: error.message });
          }
          unsubscribe();
        }
      });

      // Start agent execution in background (non-blocking)
      // Pass conversation history as context
      this.agentRunner(body.query, {
        userId,
        aclGroup,
        ragBaseUrl: `http://localhost:${this.options.port}`,
        sessionId,
        conversationId: activeConversationId ?? undefined,
        conversationState,
        conversationContext,
        userPreferences,
        conversationHistory, // Pass history to agent
        getProfilePublicKey: (_uid: string) => this.profileStore.get(profileUserId)?.publicKey ?? null,
        getProfileSshUsername: (_uid: string) => this.profileStore.get(profileUserId)?.sshUsername ?? null,
      }).catch((error: any) => {
        pceLogger.error("Agent execution error", { error: error.message, sessionId });
        unsubscribe();
      });

      // Return immediately with sessionId and conversationId so client can connect to SSE stream
      return this.jsonResponse(200, {
        success: true,
        sessionId,
        conversationId: activeConversationId,
        message: "Agent query started. Connect to /api/agent/stream?sessionId=" + sessionId + " to receive events.",
      });
    } catch (error: any) {
      pceLogger.error("Agent query endpoint error", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  /**
   * Handle Server-Sent Events (SSE) stream for agent events
   */
  private async handleAgentStream(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId") || undefined;

    // Create SSE stream
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        
        // Send initial connection message
        controller.enqueue(encoder.encode(": connected\n\n"));

        // Keepalive interval to prevent connection timeout
        const keepaliveInterval = setInterval(() => {
          try {
            // Check if controller is still open before sending keepalive
            if (controller.desiredSize !== null) {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            } else {
              // Controller closed, stop keepalive
              clearInterval(keepaliveInterval);
            }
          } catch (error) {
            // Connection closed, stop keepalive
            clearInterval(keepaliveInterval);
          }
        }, 5000); // Send keepalive every 5 seconds

        // Subscribe to event bus
        const eventBus = AgentEventBus.getInstance();
        const unsubscribe = eventBus.onEvent((event: AgentEvent) => {
          // Filter by sessionId if provided
          // Allow tool:progress events through even without matching sessionId
          // (tools emit progress without session context)
          if (sessionId && event.sessionId !== sessionId && event.type !== "tool:progress") {
            return;
          }

          try {
            // Format as SSE: "data: {json}\n\n"
            const data = `data: ${JSON.stringify(event)}\n\n`;
            controller.enqueue(encoder.encode(data));
            
            // If this is the final event, close the stream after a short delay
            if (event.type === "agent:final") {
              setTimeout(() => {
                clearInterval(keepaliveInterval);
                unsubscribe();
                try {
                  // Check if controller is still open before closing
                  if (controller.desiredSize !== null) {
                    controller.close();
                  }
                } catch (error: any) {
                  // Controller may already be closed (e.g., client disconnected), ignore
                  // This is expected behavior when client closes connection
                }
              }, 1000);
            }
          } catch (error: any) {
            pceLogger.error("Error encoding SSE event", { error: error.message });
          }
        });

        // Handle client disconnect
        req.signal.addEventListener("abort", () => {
          clearInterval(keepaliveInterval);
          unsubscribe();
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no", // Disable nginx buffering
      },
    });
  }

  /**
   * Handle GET /api/chat/history - Get chat history for a user
   */
  private async handleGetChatHistory(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const userId = url.searchParams.get("userId") || "dashboard-user";
      const limit = parseInt(url.searchParams.get("limit") || "100");
      const offset = parseInt(url.searchParams.get("offset") || "0");

      const messages = await this.chatHistoryStore.getHistory({
        userId,
        limit,
        offset,
      });

      return this.jsonResponse(200, {
        success: true,
        data: messages,
      });
    } catch (error: any) {
      pceLogger.error("Failed to get chat history", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  /**
   * Handle DELETE /api/chat/history/:id - Delete a chat message
   */
  private async handleDeleteChatMessage(req: Request, url: URL): Promise<Response> {
    try {
      const messageId = url.pathname.split("/").pop();
      if (!messageId) {
        return this.jsonResponse(400, { error: "Message ID is required" });
      }

      // Optional: Get userId from query params to ensure user can only delete their own messages
      const userId = url.searchParams.get("userId") || undefined;

      const deleted = await this.chatHistoryStore.deleteMessage(messageId, userId);
      
      if (!deleted) {
        return this.jsonResponse(404, { error: "Message not found" });
      }

      return this.jsonResponse(200, {
        success: true,
        message: "Message deleted",
      });
    } catch (error: any) {
      pceLogger.error("Failed to delete chat message", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  /**
   * Handle GET /api/chat/conversations - Get all conversations for a user
   */
  private async handleGetConversations(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const userId = url.searchParams.get("userId") || "dashboard-user";
      const limit = parseInt(url.searchParams.get("limit") || "50");

      const conversations = await this.chatHistoryStore.getConversations(userId, limit);

      return this.jsonResponse(200, {
        success: true,
        data: conversations,
      });
    } catch (error: any) {
      pceLogger.error("Failed to get conversations", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  /**
   * Handle POST /api/chat/conversations - Create a new conversation
   */
  private async handleCreateConversation(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as { userId: string; title?: string };
      const userId = body.userId || "dashboard-user";

      const conversationId = await this.chatHistoryStore.createConversation(userId, body.title);

      return this.jsonResponse(200, {
        success: true,
        data: { id: conversationId },
      });
    } catch (error: any) {
      pceLogger.error("Failed to create conversation", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  private async handleClarificationResponse(req: Request): Promise<Response> {
    try {
      const body = await req.json();
      const schema = z.object({
        userId: z.string().min(1),
        conversationId: z.string().min(1),
        clarificationId: z.string().min(1),
        optionId: z.union([z.string(), z.number()]).optional(),
        optionText: z.string().min(1),
        clarificationText: z.string().optional(),
      });
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return this.jsonResponse(400, { error: parsed.error.message });
      }

      const recordId = await this.chatHistoryStore.recordClarificationResponse({
        conversationId: parsed.data.conversationId,
        userId: parsed.data.userId,
        clarificationId: parsed.data.clarificationId,
        optionId: parsed.data.optionId?.toString(),
        optionText: parsed.data.optionText,
        clarificationText: parsed.data.clarificationText,
      });

      if (!recordId) {
        return this.jsonResponse(500, { error: "Failed to store clarification response" });
      }

      return this.jsonResponse(200, { data: { id: recordId } });
    } catch (error: any) {
      pceLogger.error("Failed to record clarification response", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  /**
   * Handle DELETE /api/chat/conversations?userId=:id - Delete all conversations and messages for a user
   */
  private async handleDeleteAllConversations(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const userId = url.searchParams.get("userId") || "dashboard-user";

      const result = await this.chatHistoryStore.deleteAllUserConversations(userId);

      return this.jsonResponse(200, {
        success: true,
        message: "All conversations deleted",
        data: result,
      });
    } catch (error: any) {
      pceLogger.error("Failed to delete all conversations", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  /**
   * Handle GET /api/chat/conversations/:id/messages - Get messages for a conversation
   */
  private async handleGetConversationMessages(req: Request, url: URL): Promise<Response> {
    try {
      const conversationId = url.pathname.split("/")[4]; // /api/chat/conversations/{id}/messages
      if (!conversationId) {
        return this.jsonResponse(400, { error: "Conversation ID is required" });
      }

      const userId = url.searchParams.get("userId") || "dashboard-user";
      const limit = parseInt(url.searchParams.get("limit") || "100");
      const offset = parseInt(url.searchParams.get("offset") || "0");

      const messages = await this.chatHistoryStore.getHistory({
        conversationId,
        userId,
        limit,
        offset,
      });

      return this.jsonResponse(200, {
        success: true,
        data: messages,
      });
    } catch (error: any) {
      pceLogger.error("Failed to get conversation messages", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  /**
   * Handle DELETE /api/chat/conversations/:id - Delete a conversation
   */
  private async handleDeleteConversation(req: Request, url: URL): Promise<Response> {
    try {
      const conversationId = url.pathname.split("/")[4]; // /api/chat/conversations/{id}
      if (!conversationId) {
        return this.jsonResponse(400, { error: "Conversation ID is required" });
      }

      const userId = url.searchParams.get("userId") || undefined;

      const deleted = await this.chatHistoryStore.deleteConversation(conversationId, userId);

      // Make delete idempotent for better UX in the dashboard:
      // - If the conversation doesn't exist or is already deleted, still return success.
      // - This avoids noisy 404s in the UI when state drifts.
      if (!deleted) {
        return this.jsonResponse(200, {
          success: true,
          message: "Conversation not found or already deleted",
        });
      }

      return this.jsonResponse(200, {
        success: true,
        message: "Conversation deleted",
      });
    } catch (error: any) {
      pceLogger.error("Failed to delete conversation", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  /**
   * Handle PATCH /api/chat/conversations/:id - Update conversation title
   */
  private async handleUpdateConversationTitle(req: Request, url: URL): Promise<Response> {
    try {
      const conversationId = url.pathname.split("/")[4]; // /api/chat/conversations/{id}
      if (!conversationId) {
        return this.jsonResponse(400, { error: "Conversation ID is required" });
      }

      const body = (await req.json()) as { title: string };
      if (!body.title) {
        return this.jsonResponse(400, { error: "Title is required" });
      }

      const userId = url.searchParams.get("userId") || undefined;

      const updated = await this.chatHistoryStore.updateConversationTitle(conversationId, body.title, userId);
      
      if (!updated) {
        return this.jsonResponse(404, { error: "Conversation not found" });
      }

      return this.jsonResponse(200, {
        success: true,
        message: "Conversation title updated",
      });
    } catch (error: any) {
      pceLogger.error("Failed to update conversation title", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  /**
   * Handle GET /api/user/preferences - Get user preferences (last active conversation)
   */
  private async handleGetUserPreferences(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const userId = url.searchParams.get("userId") || "dashboard-user";

      const lastActiveConversationId = await this.chatHistoryStore.getLastActiveConversation(userId);

      return this.jsonResponse(200, {
        success: true,
        data: {
          lastActiveConversationId,
        },
      });
    } catch (error: any) {
      pceLogger.error("Failed to get user preferences", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  /**
   * Handle PUT /api/user/preferences - Set user preferences (last active conversation)
   */
  private async handleSetUserPreferences(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as { userId: string; lastActiveConversationId?: string | null };
      const userId = body.userId || "dashboard-user";
      const conversationId = body.lastActiveConversationId || null;

      const success = await this.chatHistoryStore.setLastActiveConversation(userId, conversationId);

      if (!success) {
        return this.jsonResponse(500, { error: "Failed to update preferences" });
      }

      return this.jsonResponse(200, {
        success: true,
        data: {
          lastActiveConversationId: conversationId,
        },
      });
    } catch (error: any) {
      pceLogger.error("Failed to set user preferences", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  /**
   * Handle GET /api/user/profile - Get user profile (display name, SSH username, public key)
   */
  private async handleGetUserProfile(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const userId = url.searchParams.get("userId") || "dashboard-user";

      const profile = this.profileStore.get(userId);
      if (!profile) {
        return this.jsonResponse(200, {
          success: true,
          data: {
            userId,
            displayName: null,
            sshUsername: "ops",
            publicKey: null,
            updatedAt: null,
          },
        });
      }

      return this.jsonResponse(200, {
        success: true,
        data: {
          userId: profile.userId,
          displayName: profile.displayName,
          sshUsername: profile.sshUsername,
          publicKey: profile.publicKey,
          updatedAt: profile.updatedAt,
        },
      });
    } catch (error: any) {
      pceLogger.error("Failed to get user profile", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  /**
   * Handle PUT /api/user/profile - Set user profile (display name, SSH username, public key)
   */
  private async handleSetUserProfile(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as {
        userId?: string;
        displayName?: string | null;
        sshUsername?: string;
        publicKey?: string | null;
      };
      const userId = body.userId || "dashboard-user";

      if (body.publicKey !== undefined && body.publicKey !== null && body.publicKey !== "") {
        const keyTrimmed = String(body.publicKey).trim();
        if (!isValidPublicKeyLine(keyTrimmed)) {
          return this.jsonResponse(400, {
            error: "Invalid public key format. Expected a line starting with ssh-ed25519, ssh-rsa, or ecdsa-sha2-.",
          });
        }
      }

      const profile = this.profileStore.upsert({
        userId,
        displayName: body.displayName,
        sshUsername: body.sshUsername,
        publicKey: body.publicKey === "" ? null : body.publicKey ?? undefined,
      });

      return this.jsonResponse(200, {
        success: true,
        data: {
          userId: profile.userId,
          displayName: profile.displayName,
          sshUsername: profile.sshUsername,
          publicKey: profile.publicKey,
          updatedAt: profile.updatedAt,
        },
      });
    } catch (error: any) {
      pceLogger.error("Failed to set user profile", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  /**
   * Handle GET /api/user/profiles - List all user profiles
   */
  private async handleListProfiles(req: Request): Promise<Response> {
    try {
      const profiles = this.profileStore.list();
      return this.jsonResponse(200, {
        success: true,
        data: profiles.map(p => ({
          userId: p.userId,
          displayName: p.displayName,
          sshUsername: p.sshUsername,
          hasPublicKey: !!p.publicKey,
          updatedAt: p.updatedAt,
        })),
      });
    } catch (error: any) {
      pceLogger.error("Failed to list profiles", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }

  /**
   * Handle DELETE /api/user/profile - Delete a user profile
   */
  private async handleDeleteProfile(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url);
      const userId = url.searchParams.get("userId");
      if (!userId) {
        return this.jsonResponse(400, { error: "userId is required" });
      }
      this.profileStore.delete(userId);
      return this.jsonResponse(200, { success: true });
    } catch (error: any) {
      pceLogger.error("Failed to delete profile", { error: error.message });
      return this.jsonResponse(500, { error: error.message });
    }
  }
}

export interface BootstrapPceApiServerOptions extends PceApiServerOptions {
  fusionConfig?: Partial<FusionConfig>;
  /** Use this Qdrant collection instead of default (e.g. for audit/gold-path scripts). */
  vectorStoreCollectionName?: string;
}

export async function bootstrapPceApiServer(options: BootstrapPceApiServerOptions = {}) {
  const { fusionConfig, vectorStoreCollectionName, ...serverOptions } = options;
  const embeddingService = new EmbeddingService();
  const collectionName = vectorStoreCollectionName ?? DEFAULT_COLLECTION;
  const vectorStore = new QdrantVectorStore(undefined, undefined, collectionName);
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
