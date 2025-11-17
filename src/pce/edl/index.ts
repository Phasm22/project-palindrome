/**
 * Entity Disambiguation Layer - Main Module
 */

export { EntityExtractor, type ExtractedEntity, type ExtractedRelationship, type ExtractionResult } from "./extraction/extractor";
export { validateEntityType, validateExtractionResults } from "./validation/validator";
export { normalizeEntityText, normalizeEntity, generateCanonicalId } from "./normalization/normalizer";
export { AliasMapper, type AliasMatch } from "./normalization/alias-mapper";
export { EDLPipeline, type EDLPipelineResult } from "./pipeline";

