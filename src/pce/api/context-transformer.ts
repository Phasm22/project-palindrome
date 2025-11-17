import type { HybridContext } from "../types";
import type { ApiHybridContext } from "./types";

export function transformHybridContext(context?: HybridContext): ApiHybridContext {
  if (!context) {
    return {
      semanticChunks: [],
      structuralPaths: [],
      provenance: [],
    };
  }

  return {
    semanticChunks: context.semanticChunks.map((item) => ({
      id: item.chunk.id,
      text: item.chunk.text,
      score: item.score,
      sourcePath: item.chunk.metadata.sourcePath,
      versionHash: item.chunk.metadata.versionHash,
      aclGroup: item.chunk.metadata.aclGroup,
      chunkIndex: item.chunk.metadata.chunkIndex,
      totalChunks: item.chunk.metadata.totalChunks,
    })),
    structuralPaths: context.structuralPaths.map((path) => ({
      score: path.score,
      entities: path.entities,
      relationships: path.relationships,
    })),
    provenance: context.provenance,
  };
}
