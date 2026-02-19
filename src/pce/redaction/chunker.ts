/**
 * Redaction Pipeline - Document Chunking
 * Task 2.2: Document-Type-Aware Chunking (V1)
 */

import type { DocumentType, DocumentChunk, ChunkMetadata } from "../types";
import { pceLogger } from "../utils/logger";

export interface ChunkingConfig {
  maxChunkSize: number;
  overlapSize: number;
}

const DEFAULT_CONFIG: ChunkingConfig = {
  maxChunkSize: 1000, // characters
  overlapSize: 200, // characters
};

/**
 * Chunk markdown runbooks by header/section
 */
function chunkMarkdownRunbook(
  text: string,
  metadata: Omit<ChunkMetadata, "chunkIndex" | "totalChunks">,
  config: ChunkingConfig = DEFAULT_CONFIG
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  
  // Split by markdown headers (##, ###, etc.)
  const headerRegex = /^(#{1,6})\s+(.+)$/gm;
  const sections: Array<{ start: number; end: number; title: string }> = [];
  
  let lastIndex = 0;
  let match;
  
  while ((match = headerRegex.exec(text)) !== null) {
    if (sections.length > 0) {
      const previousSection = sections[sections.length - 1];
      if (previousSection) {
        previousSection.end = match.index;
      }
    }
    
    sections.push({
      start: match.index,
      end: text.length,
      title: (match[2] ?? "Section").trim(),
    });
    
    lastIndex = match.index + match[0].length;
  }
  
  // If no headers found, treat as single section
  if (sections.length === 0) {
    sections.push({ start: 0, end: text.length, title: "Content" });
  }
  
  // Create chunks from sections
  sections.forEach((section, index) => {
    if (!section) return;
    const sectionText = text.slice(section.start, section.end).trim();
    
    // If section is too large, split it further
    if (sectionText.length > config.maxChunkSize) {
      const subChunks = chunkGenericText(sectionText, metadata, config);
      chunks.push(...subChunks);
    } else if (sectionText.length > 0) {
      chunks.push({
        id: `${metadata.versionHash}-${index}`,
        text: sectionText,
        metadata: {
          ...metadata,
          chunkIndex: chunks.length,
          totalChunks: 0, // Will be set later
        },
        startIndex: section.start,
        endIndex: section.end,
      });
    }
  });
  
  // Update totalChunks
  chunks.forEach((chunk) => {
    chunk.metadata.totalChunks = chunks.length;
  });
  
  pceLogger.debug(`Chunked markdown runbook into ${chunks.length} sections`);
  return chunks;
}

/**
 * Chunk generic text with fixed overlap/size
 */
function chunkGenericText(
  text: string,
  metadata: Omit<ChunkMetadata, "chunkIndex" | "totalChunks">,
  config: ChunkingConfig = DEFAULT_CONFIG
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let startIndex = 0;
  let chunkIndex = 0;
  
  while (startIndex < text.length) {
    let endIndex = Math.min(startIndex + config.maxChunkSize, text.length);
    
    // Try to break at word boundary
    if (endIndex < text.length) {
      const lastSpace = text.lastIndexOf(" ", endIndex);
      if (lastSpace > startIndex + config.maxChunkSize * 0.5) {
        endIndex = lastSpace;
      }
    }
    
    const chunkText = text.slice(startIndex, endIndex).trim();
    
    if (chunkText.length > 0) {
      chunks.push({
        id: `${metadata.versionHash}-${chunkIndex}`,
        text: chunkText,
        metadata: {
          ...metadata,
          chunkIndex,
          totalChunks: 0, // Will be set later
        },
        startIndex,
        endIndex,
      });
      chunkIndex++;
    }
    
    // Move start index with overlap
    startIndex = endIndex - config.overlapSize;
    const lastChunk = chunks[chunks.length - 1];
    if ((lastChunk && startIndex <= lastChunk.startIndex) || startIndex < 0) {
      startIndex = endIndex;
    }
  }
  
  // Update totalChunks
  chunks.forEach((chunk) => {
    chunk.metadata.totalChunks = chunks.length;
  });
  
  pceLogger.debug(`Chunked generic text into ${chunks.length} chunks`);
  return chunks;
}

/**
 * Main chunking function - routes to appropriate chunker based on document type
 */
export function chunkDocument(
  text: string,
  documentType: DocumentType,
  metadata: Omit<ChunkMetadata, "chunkIndex" | "totalChunks">,
  config: ChunkingConfig = DEFAULT_CONFIG
): DocumentChunk[] {
  switch (documentType) {
    case "markdown_runbook":
      return chunkMarkdownRunbook(text, metadata, config);
    case "generic_text":
    case "yaml_config":
    case "log_file":
    default:
      return chunkGenericText(text, metadata, config);
  }
}
