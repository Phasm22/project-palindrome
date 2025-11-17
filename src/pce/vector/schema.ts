/**
 * Vector Database - Schema Definition
 * Task 3.0: Define Vector Collection Schema
 */

import type { ChunkMetadata } from "../types";

/**
 * Vector collection schema metadata fields
 * All chunks indexed must include these fields
 */
export interface VectorMetadata extends ChunkMetadata {
  // Inherited from ChunkMetadata:
  // - versionHash: string
  // - aclGroup: string
  // - sourceType: string
  // - sourcePath: string
  // - timestamp: Date
  // - chunkIndex: number
  // - totalChunks: number
}

/**
 * Qdrant payload structure
 */
export interface QdrantPayload {
  text: string;
  version_hash: string;
  acl_group: string;
  source_type: string;
  source_path: string;
  timestamp: string; // ISO string
  chunk_index: number;
  total_chunks: number;
}

/**
 * Convert ChunkMetadata to Qdrant payload format
 */
export function metadataToPayload(metadata: ChunkMetadata, text: string): QdrantPayload {
  return {
    text,
    version_hash: metadata.versionHash,
    acl_group: metadata.aclGroup,
    source_type: metadata.sourceType,
    source_path: metadata.sourcePath,
    timestamp: metadata.timestamp.toISOString(),
    chunk_index: metadata.chunkIndex,
    total_chunks: metadata.totalChunks,
  };
}

/**
 * Convert Qdrant payload back to ChunkMetadata
 */
export function payloadToMetadata(payload: QdrantPayload): ChunkMetadata {
  return {
    versionHash: payload.version_hash,
    aclGroup: payload.acl_group,
    sourceType: payload.source_type as any,
    sourcePath: payload.source_path,
    timestamp: new Date(payload.timestamp),
    chunkIndex: payload.chunk_index,
    totalChunks: payload.total_chunks,
  };
}

