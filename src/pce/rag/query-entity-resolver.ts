/**
 * Phase I-C: Query Entity Resolver
 * Task 8.2: Input Entity Recognition (Query-Time)
 * Task 8.2.1: Query Entity Resolution Validation
 * Task 8.2.2: Partial Entity Resolution Handling
 */

import type { ExtractedQueryEntity, QueryAnalysis } from "../types";
import { GraphQueryInterface } from "../kg/queries/query-interface";
import { normalizeEntityText, generateCanonicalId } from "../edl/normalization/normalizer";
import { pceLogger } from "../utils/logger";

export interface EntityResolutionResult {
  entities: ExtractedQueryEntity[];
  allResolved: boolean;
  someResolved: boolean;
  noneResolved: boolean;
}

/**
 * Query Entity Resolver
 * Extracts entities from queries and resolves them to canonical IDs
 */
export class QueryEntityResolver {
  private graphQuery: GraphQueryInterface;

  constructor(graphQuery: GraphQueryInterface) {
    this.graphQuery = graphQuery;
  }

  /**
   * Task 8.2: Extract entities from query and resolve to canonical IDs
   */
  async resolveEntities(query: string): Promise<EntityResolutionResult> {
    try {
      pceLogger.debug("Resolving entities from query", { query });

      // Extract potential entity mentions from query
      const extracted = this.extractEntityMentions(query);

      // Resolve each entity to canonical ID
      const resolved = await Promise.all(
        extracted.map((entity) => this.resolveEntity(entity))
      );

      const allResolved = resolved.every((e) => e.resolved);
      const someResolved = resolved.some((e) => e.resolved);
      const noneResolved = !someResolved;

      // Task 8.2.1: Log resolution misses
      if (noneResolved && extracted.length > 0) {
        pceLogger.warn("No entities resolved from query", {
          query,
          extractedCount: extracted.length,
        });
        // Increment resolution_miss_count
        pceLogger.incrementCounter("resolution_miss_count");
      }

      return {
        entities: resolved,
        allResolved,
        someResolved,
        noneResolved,
      };
    } catch (error: any) {
      pceLogger.error("Entity resolution failed", { error: error.message });
      // Return empty result on error
      return {
        entities: [],
        allResolved: false,
        someResolved: false,
        noneResolved: true,
      };
    }
  }

  /**
   * Extract potential entity mentions from query text
   * Uses pattern matching for common entity formats
   */
  private extractEntityMentions(query: string): Array<{ text: string; type: string | null }> {
    const entities: Array<{ text: string; type: string | null }> = [];

    // Pattern: host-123, server-abc, host_123
    const hostPattern = /\b(?:host|server|node|machine)[-_]?([a-z0-9-]+)\b/gi;
    let match;
    while ((match = hostPattern.exec(query)) !== null) {
      entities.push({
        text: match[0],
        type: "Host",
      });
    }

    // Pattern: service-123, port-80, service_http
    const servicePattern = /\b(?:service|port|app)[-_]?([a-z0-9-]+)\b/gi;
    while ((match = servicePattern.exec(query)) !== null) {
      entities.push({
        text: match[0],
        type: "Service",
      });
    }

    // Pattern: alert-123, alert_critical
    const alertPattern = /\b(?:alert|alarm|warning)[-_]?([a-z0-9-]+)\b/gi;
    while ((match = alertPattern.exec(query)) !== null) {
      entities.push({
        text: match[0],
        type: "Alert",
      });
    }

    // Pattern: network-123, subnet-10.0.0.0
    const networkPattern = /\b(?:network|subnet|vlan)[-_]?([a-z0-9.-]+)\b/gi;
    while ((match = networkPattern.exec(query)) !== null) {
      entities.push({
        text: match[0],
        type: "Network",
      });
    }

    // Pattern: IP addresses
    const ipPattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
    while ((match = ipPattern.exec(query)) !== null) {
      entities.push({
        text: match[0],
        type: "Host", // IPs typically map to hosts
      });
    }

    // Pattern: domain names
    const domainPattern = /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi;
    while ((match = domainPattern.exec(query)) !== null) {
      // Skip if it's part of a URL or email
      if (!query.includes(`http://${match[0]}`) && !query.includes(`https://${match[0]}`) && !query.includes(`@${match[0]}`)) {
        entities.push({
          text: match[0],
          type: "Host",
        });
      }
    }

    // Remove duplicates
    const unique = new Map<string, { text: string; type: string | null }>();
    for (const entity of entities) {
      const key = entity.text.toLowerCase();
      if (!unique.has(key)) {
        unique.set(key, entity);
      }
    }

    return Array.from(unique.values());
  }

  /**
   * Resolve a single entity to canonical ID
   */
  private async resolveEntity(entity: { text: string; type: string | null }): Promise<ExtractedQueryEntity> {
    try {
      // Try to find entity in graph by text match
      // First, try exact match by ID pattern
      const canonicalId = this.generateCanonicalId(entity.text, entity.type);
      
      // Query graph to see if this entity exists
      const exists = await this.entityExistsInGraph(canonicalId, entity.text, entity.type);

      if (exists) {
        return {
          text: entity.text,
          canonicalId,
          type: entity.type,
          resolved: true,
          confidence: 1.0,
        };
      }

      // Try fuzzy match by querying entities of the same type
      const fuzzyMatch = await this.findFuzzyMatch(entity.text, entity.type);
      if (fuzzyMatch) {
        return {
          text: entity.text,
          canonicalId: fuzzyMatch.id,
          type: fuzzyMatch.type,
          resolved: true,
          confidence: fuzzyMatch.confidence,
        };
      }

      // Not found
      return {
        text: entity.text,
        canonicalId: null,
        type: entity.type,
        resolved: false,
        confidence: 0.0,
      };
    } catch (error: any) {
      pceLogger.debug("Entity resolution error", { entity, error: error.message });
      return {
        text: entity.text,
        canonicalId: null,
        type: entity.type,
        resolved: false,
        confidence: 0.0,
      };
    }
  }

  /**
   * Generate canonical ID from entity text and type
   * Uses the same normalization as EDL pipeline
   */
  private generateCanonicalId(text: string, type: string | null): string {
    if (!type) {
      const normalized = normalizeEntityText(text);
      return normalized;
    }
    
    const normalized = normalizeEntityText(text);
    return generateCanonicalId(normalized, type);
  }

  /**
   * Check if entity exists in graph
   */
  private async entityExistsInGraph(canonicalId: string, text: string, type: string | null): Promise<boolean> {
    try {
      // Query by canonical ID (exact match)
      const result = await this.graphQuery.executeQuery(
        `MATCH (n {id: $id}) RETURN n LIMIT 1`,
        { id: canonicalId }
      );
      
      if (result.nodes.length > 0) {
        return true;
      }

      // Try querying by type and normalized text match
      if (type) {
        const normalizedText = normalizeEntityText(text);
        const typeResult = await this.graphQuery.executeQuery(
          `MATCH (n:${type}) 
           WHERE n.id = $canonicalId 
              OR n.id ENDS WITH $normalizedText
              OR toLower(n.id) CONTAINS toLower($text)
           RETURN n LIMIT 1`,
          { 
            canonicalId,
            normalizedText,
            text: normalizedText
          }
        );
        
        if (typeResult.nodes.length > 0) {
          return true;
        }
      }

      // Try without type constraint (broader search)
      const broadResult = await this.graphQuery.executeQuery(
        `MATCH (n) 
         WHERE n.id = $canonicalId 
            OR n.id ENDS WITH $normalizedText
         RETURN n LIMIT 5`,
        { 
          canonicalId,
          normalizedText: normalizeEntityText(text)
        }
      );
      
      return broadResult.nodes.length > 0;
    } catch (error: any) {
      pceLogger.debug("Entity existence check failed", { canonicalId, error: error.message });
      return false;
    }
  }

  /**
   * Find fuzzy match for entity
   */
  private async findFuzzyMatch(text: string, type: string | null): Promise<{ id: string; type: string; confidence: number } | null> {
    try {
      const normalizedText = normalizeEntityText(text);
      
      // Query entities - try with type first, then without
      let result;
      if (type) {
        result = await this.graphQuery.executeQuery(
          `MATCH (n:${type}) RETURN n LIMIT 100`
        );
      } else {
        result = await this.graphQuery.executeQuery(
          `MATCH (n) RETURN n LIMIT 100`
        );
      }

      // Match against normalized text
      let bestMatch: { id: string; type: string; confidence: number } | null = null;
      let bestScore = 0;

      for (const node of result.nodes) {
        const nodeId = node.id.toLowerCase();
        const nodeNormalized = normalizeEntityText(nodeId);
        
        // Check exact match on normalized text
        if (nodeNormalized === normalizedText || nodeId === normalizedText) {
          return {
            id: node.id,
            type: node.type,
            confidence: 1.0,
          };
        }
        
        // Check if node ID contains normalized text or vice versa
        if (nodeId.includes(normalizedText) || normalizedText.includes(nodeId)) {
          const similarity = 0.9;
          if (similarity > bestScore) {
            bestScore = similarity;
            bestMatch = {
              id: node.id,
              type: node.type,
              confidence: similarity,
            };
          }
        } else {
          // Calculate similarity
          const similarity = this.calculateSimilarity(normalizedText, nodeNormalized);
          
          if (similarity > bestScore && similarity > 0.7) {
            bestScore = similarity;
            bestMatch = {
              id: node.id,
              type: node.type,
              confidence: similarity,
            };
          }
        }
      }

      return bestMatch;
    } catch (error: any) {
      pceLogger.debug("Fuzzy match failed", { text, error: error.message });
      return null;
    }
  }

  /**
   * Simple similarity calculation (Jaro-Winkler-like)
   */
  private calculateSimilarity(s1: string, s2: string): number {
    if (s1 === s2) return 1.0;
    if (s1.includes(s2) || s2.includes(s1)) return 0.9;
    
    // Simple character overlap
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    
    if (longer.length === 0) return 1.0;
    
    const matches = longer.split("").filter((c) => shorter.includes(c)).length;
    return matches / longer.length;
  }
}

