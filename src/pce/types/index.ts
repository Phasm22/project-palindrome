/**
 * PCE Phase I-A Type Definitions
 */

export type DocumentStatus = "NEW" | "MODIFIED" | "UNCHANGED";

export type DocumentType = "markdown_runbook" | "generic_text" | "yaml_config" | "log_file";

export type ACLGroup = string; // e.g., "admin", "operator", "viewer"

export interface DocumentSnapshot {
  filePath: string;
  sha256Hash: string;
  timestamp: Date;
  aclGroup: ACLGroup;
  documentType: DocumentType;
  size: number;
}

export interface DocumentChunk {
  id: string;
  text: string;
  metadata: ChunkMetadata;
  startIndex: number;
  endIndex: number;
}

export interface ChunkMetadata {
  versionHash: string;
  aclGroup: ACLGroup;
  sourceType: DocumentType;
  sourcePath: string;
  timestamp: Date;
  chunkIndex: number;
  totalChunks: number;
}

export interface VectorDocument {
  id: string;
  vector: number[];
  payload: {
    text: string;
    metadata: ChunkMetadata;
  };
}

export interface RetrievalConfig {
  topK: number;
  maxTokens: number;
  similarityThreshold?: number;
}

export interface AccessDeniedMetadata {
  reason: string;
  matchedCount: number;
  filteredCount: number;
}

export interface RetrievalResult {
  chunks: DocumentChunk[];
  scores: number[];
  queryEmbedding?: number[];
  accessDeniedInfo?: AccessDeniedMetadata;
}

export interface RAGResponse {
  answer: string;
  sources: Array<{
    chunkId: string;
    sourcePath: string;
    score: number;
    text: string;
  }>;
  metadata: {
    tokensUsed: number;
    chunksRetrieved: number;
  };
}

// Phase I-C: Hybrid Orchestration Types

export type QueryType = "SEMANTIC_ONLY" | "STRUCTURAL_PRIMARY" | "HYBRID";

export interface QueryAnalysis {
  queryType: QueryType;
  entities: ExtractedQueryEntity[];
  structuralIndicators: string[];
}

export interface ExtractedQueryEntity {
  text: string;
  canonicalId: string | null;
  type: string | null;
  resolved: boolean;
  confidence: number;
}

export interface FusionWeights {
  vector: number;
  graph: number;
  recency: number;
}

export interface FusionConfig {
  weights: FusionWeights;
  minVectorScore: number;
  minGraphScore: number;
  minTotalScore: number;
  maxTokens: number;
}

export interface HybridRetrievalResult {
  vectorResult: RetrievalResult;
  graphResult: GraphRetrievalResult;
  fusionScores: Array<{
    itemId: string;
    vectorScore: number;
    graphScore: number;
    recencyScore: number;
    totalScore: number;
  }>;
  prunedContext: HybridContext;
}

export interface GraphRetrievalResult {
  entities: Array<{
    id: string;
    type: string;
    attributes: Record<string, any>;
    versionHash?: string;
    sourcePath?: string;
    confidence?: number;
    aclGroup?: ACLGroup;
  }>;
  relationships: Array<{
    from: string;
    to: string;
    type: string;
    versionHash?: string;
    sourcePath?: string;
    confidence?: number;
    aclGroup?: ACLGroup;
  }>;
  paths?: Array<{
    nodes: string[];
    relationships: string[];
  }>;
  provenance: Array<{
    versionHash: string;
    sourcePath: string;
  }>;
}

export interface HybridContext {
  semanticChunks: Array<{
    chunk: DocumentChunk;
    score: number;
  }>;
  structuralPaths: Array<{
    entities: GraphRetrievalResult["entities"];
    relationships: GraphRetrievalResult["relationships"];
    score: number;
  }>;
  provenance: Array<{
    versionHash: string;
    sourcePath: string;
  }>;
}

export interface HybridRAGResponse extends RAGResponse {
  queryType: QueryType;
  fusionMetrics?: {
    vectorResults: number;
    graphResults: number;
    fusedResults: number;
    prunedResults: number;
    avgTotalScore: number;
  };
  fallbackMode?: "graph_down" | "low_score" | null;
  context?: HybridContext;
  sTotalScore: number | null;
}

