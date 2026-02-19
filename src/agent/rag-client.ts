import { logger } from "../utils/logger";

export interface HybridApiContext {
  answer: string;
  queryType: string;
  fallbackMode: string | null;
  sources: Array<{ sourcePath: string; score: number; chunkId: string }>;
  metadata: { tokensUsed: number; chunksRetrieved: number };
  fusionMetrics?: {
    vectorResults: number;
    graphResults: number;
    fusedResults: number;
    prunedResults: number;
    avgTotalScore: number;
  };
  context: {
    semanticChunks: Array<{
      id: string;
      text: string;
      score: number;
      sourcePath: string;
      versionHash: string;
      aclGroup: string;
      chunkIndex: number;
      totalChunks: number;
    }>;
    structuralPaths: Array<{
      score: number;
      entities: Array<Record<string, any>>;
      relationships: Array<Record<string, any>>;
    }>;
    provenance: Array<{ versionHash: string; sourcePath: string }>;
  };
  sTotalScore: number | null;
}

export interface FetchRagOptions {
  baseUrl?: string;
  userId?: string;
  aclGroup?: string;
  timeoutMs?: number;
}

export async function fetchHybridContext(
  query: string,
  options: FetchRagOptions = {}
): Promise<HybridApiContext | null> {
  const baseUrl = (options.baseUrl ?? process.env.PCE_API_URL ?? process.env.PCE_API_BASE_URL)?.replace(/\/$/, "");
  if (!baseUrl) {
    return null;
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 5000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        aclGroup: options.aclGroup ?? "admin",
        userId: options.userId ?? "agent-session",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.error(`Hybrid context fetch failed: HTTP ${response.status}`);
      return null;
    }

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const payloadRecord = payload as { data?: unknown };
    return (payloadRecord.data as HybridApiContext | undefined) ?? null;
  } catch (error: any) {
    // Don't log connection errors as errors if API server isn't running - this is expected in some scenarios
    if (error.name === 'AbortError' || error.message?.includes('ECONNREFUSED') || error.message?.includes('fetch failed')) {
      logger.debug(`Hybrid context fetch skipped: API server not available at ${baseUrl}`);
    } else {
      logger.error(`Hybrid context fetch error: ${error.message ?? error}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
