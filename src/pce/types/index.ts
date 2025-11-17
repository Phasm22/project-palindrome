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

export interface RetrievalResult {
  chunks: DocumentChunk[];
  scores: number[];
  queryEmbedding?: number[];
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

