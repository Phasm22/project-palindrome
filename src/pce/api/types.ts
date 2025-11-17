import type { ACLGroup, QueryType, HybridContext, HybridRAGResponse } from "../types";

export interface ApiHybridContextSemanticChunk {
  id: string;
  text: string;
  score: number;
  sourcePath: string;
  versionHash: string;
  aclGroup: ACLGroup;
  chunkIndex: number;
  totalChunks: number;
}

export interface ApiHybridContextStructuralPath {
  score: number;
  entities: HybridContext["structuralPaths"][number]["entities"];
  relationships: HybridContext["structuralPaths"][number]["relationships"];
}

export interface ApiHybridContext {
  semanticChunks: ApiHybridContextSemanticChunk[];
  structuralPaths: ApiHybridContextStructuralPath[];
  provenance: HybridContext["provenance"];
}

export interface ApiQueryResponse {
  answer: string;
  queryType: QueryType;
  fallbackMode: HybridRAGResponse["fallbackMode"];
  sources: HybridRAGResponse["sources"];
  metadata: HybridRAGResponse["metadata"];
  fusionMetrics?: HybridRAGResponse["fusionMetrics"];
  context: ApiHybridContext;
  sTotalScore: number | null;
}

export interface ApiHistoryEntry {
  timestamp: string;
  query: string;
  aclGroup: ACLGroup;
  response: ApiQueryResponse;
}

export interface ApiHistoryPayload {
  userId: string;
  entries: ApiHistoryEntry[];
}

export interface DependencyHealthCheck {
  name: string;
  check: () => Promise<boolean>;
}

export interface DependencyHealthStatus {
  name: string;
  healthy: boolean;
  lastChecked: string;
}

export interface HealthPayload {
  status: "ok" | "degraded";
  uptimeMs: number;
  dependencies: DependencyHealthStatus[];
}

export interface MetricsPayload {
  snapshot: Record<string, any>;
  counters: Record<string, number>;
  timestamp: string;
}
