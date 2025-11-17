/**
 * Entity Disambiguation Layer - Complete Pipeline
 * Integrates extraction, validation, normalization, and alias mapping
 */

import type { DocumentChunk } from "../types";
import type { NodeType, RelationshipType, GraphNode, GraphRelationship } from "../kg/schema/ontology";
import { EntityExtractor, type ExtractedEntity, type ExtractedRelationship } from "./extraction/extractor";
import { validateExtractionResults } from "./validation/validator";
import { normalizeEntity, generateCanonicalId } from "./normalization/normalizer";
import { AliasMapper } from "./normalization/alias-mapper";
import { validateNodeAttributes } from "../kg/schema/ontology";
import { pceLogger } from "../utils/logger";

export interface EDLPipelineResult {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  stats: {
    entitiesExtracted: number;
    entitiesValidated: number;
    entitiesNormalized: number;
    aliasesResolved: number;
    relationshipsExtracted: number;
  };
}

/**
 * Complete EDL Pipeline
 */
export class EDLPipeline {
  private extractor: EntityExtractor;
  private aliasMapper: AliasMapper;

  constructor(extractor?: EntityExtractor, aliasMapper?: AliasMapper) {
    this.extractor = extractor || new EntityExtractor();
    this.aliasMapper = aliasMapper || new AliasMapper();
  }

  /**
   * Process chunks through EDL pipeline
   */
  async processChunks(
    chunks: DocumentChunk[]
  ): Promise<EDLPipelineResult> {
    const stats = {
      entitiesExtracted: 0,
      entitiesValidated: 0,
      entitiesNormalized: 0,
      aliasesResolved: 0,
      relationshipsExtracted: 0,
    };

    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    const nodeMap = new Map<string, GraphNode>();

    // Process each chunk
    for (const chunk of chunks) {
      try {
        // Step 1: Extract entities and relationships
        const extraction = await this.extractor.extract(chunk.text);
        stats.entitiesExtracted += extraction.entities.length;
        stats.relationshipsExtracted += extraction.relationships.length;

        // Step 2: Validate entity types
        const validated = validateExtractionResults(extraction.entities);
        stats.entitiesValidated += validated.length;

        // Step 3: Normalize and create nodes
        for (const entity of validated) {
          // Filter by confidence
          if (entity.confidence < 0.7) {
            continue;
          }

          const normalized = normalizeEntity(entity.text, entity.type);
          stats.entitiesNormalized++;

          // Step 4: Check for aliases
          const aliasMatch = this.aliasMapper.findAlias(entity.text, entity.type);

          let canonicalId: string;
          if (aliasMatch && aliasMatch.isAlias) {
            canonicalId = aliasMatch.canonicalId;
            stats.aliasesResolved++;
            pceLogger.debug(`Alias resolved: "${entity.text}" -> ${canonicalId}`);
          } else {
            canonicalId = normalized.canonicalId;
            // Register as new canonical entity
            this.aliasMapper.registerCanonical(canonicalId, normalized.normalizedText, entity.text);
          }

          // Step 5: Validate attributes
          const attributes: any = {
            // Extract basic attributes from entity text
            name: entity.text,
            ...(entity.type === "Host" && { hostname: entity.text }),
            ...(entity.type === "Service" && { name: entity.text }),
          };

          const validation = validateNodeAttributes(entity.type, attributes);
          if (!validation.valid) {
            pceLogger.warn(`Invalid attributes for entity ${canonicalId}`, { errors: validation.errors });
            continue;
          }

          // Step 6: Create or update node
          if (!nodeMap.has(canonicalId)) {
            const node: GraphNode = {
              id: canonicalId,
              type: entity.type,
              attributes,
              aliases: aliasMatch ? undefined : [entity.text],
              versionHash: chunk.metadata.versionHash,
              sourcePath: chunk.metadata.sourcePath,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            nodeMap.set(canonicalId, node);
            nodes.push(node);
          } else {
            // Update existing node
            const existing = nodeMap.get(canonicalId)!;
            if (!existing.aliases) existing.aliases = [];
            if (!existing.aliases.includes(entity.text)) {
              existing.aliases.push(entity.text);
            }
            existing.updatedAt = new Date();
          }
        }

        // Step 7: Create relationships
        for (const rel of extraction.relationships) {
          if (rel.confidence < 0.7) {
            continue;
          }

          // Normalize relationship entities
          const fromNormalized = normalizeEntity(rel.from, "Host"); // Simplified - would need type detection
          const toNormalized = normalizeEntity(rel.to, "Host");

          // Find canonical IDs
          const fromAlias = this.aliasMapper.findAlias(rel.from, "Host");
          const toAlias = this.aliasMapper.findAlias(rel.to, "Host");

          const fromId = fromAlias?.isAlias ? fromAlias.canonicalId : fromNormalized.canonicalId;
          const toId = toAlias?.isAlias ? toAlias.canonicalId : toNormalized.canonicalId;

          // Skip if nodes don't exist
          if (!nodeMap.has(fromId) || !nodeMap.has(toId)) {
            continue;
          }

          const relationship: GraphRelationship = {
            id: `${fromId}-${rel.type}-${toId}`,
            type: rel.type,
            from: fromId,
            to: toId,
            versionHash: chunk.metadata.versionHash,
            sourcePath: chunk.metadata.sourcePath,
            createdAt: new Date(),
          };

          relationships.push(relationship);
        }
      } catch (error: any) {
        pceLogger.error(`Failed to process chunk ${chunk.id}`, { error: error.message });
      }
    }

    pceLogger.info("EDL pipeline complete", stats);

    return {
      nodes: Array.from(nodeMap.values()),
      relationships,
      stats,
    };
  }
}

