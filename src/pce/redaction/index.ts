/**
 * Redaction Pipeline - Main Module
 */

export { DEFAULT_REDACTION_PATTERNS, type RedactionPattern } from "./patterns";
export { Redactor, type RedactionResult } from "./redactor";
export { chunkDocument, type ChunkingConfig } from "./chunker";
export { runRedactionTests, type TestCase } from "./test-harness";

