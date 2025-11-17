/**
 * Entity Disambiguation Layer - Entity Extraction Module
 * Task 6.1: Entity Extraction Module (NLP)
 */

import OpenAI from "openai";
import type { NodeType, RelationshipType } from "../../kg/schema";
import { pceLogger } from "../../utils/logger";

export interface ExtractedEntity {
  text: string; // Original text from chunk
  type: NodeType;
  confidence: number;
  startIndex: number;
  endIndex: number;
}

export interface ExtractedRelationship {
  from: string; // Entity text
  to: string; // Entity text
  type: RelationshipType;
  confidence: number;
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

/**
 * LLM-based Entity Extractor
 * Uses GPT to extract entities and relationships from text
 */
export class EntityExtractor {
  private openai: OpenAI | null = null;
  private model: string;

  constructor(model: string = "gpt-4o-mini") {
    this.model = model;
  }

  private getClient(): OpenAI {
    if (!this.openai) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY environment variable is not set");
      }
      this.openai = new OpenAI({ apiKey });
    }
    return this.openai;
  }

  /**
   * Extract entities and relationships from chunk text
   */
  async extract(chunkText: string): Promise<ExtractionResult> {
    try {
      const client = this.getClient();

      const systemPrompt = `You are an entity extraction system for IT/Security infrastructure.
Extract entities (Hosts, Services, VLANs, Alerts, Users, Networks, FirewallRules, Configs) and their relationships from the text.

Return a JSON object with:
- entities: array of {text, type, confidence, startIndex, endIndex}
- relationships: array of {from, to, type, confidence}

Entity types: Host, Service, VLAN, Alert, User, Network, FirewallRule, Config
Relationship types: CONNECTS_TO, AFFECTS, CONFIGURED_BY, OWNS, LOGGED_BY, RUNS_ON, BELONGS_TO, TRIGGERS, ACCESSES

Be precise and only extract entities you're confident about (confidence >= 0.7).`;

      const response = await client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Extract entities and relationships from:\n\n${chunkText}` },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error("No response from LLM");
      }

      const result = JSON.parse(content) as ExtractionResult;

      // Validate and enrich with indices if missing
      result.entities = result.entities.map((entity) => {
        if (entity.startIndex === undefined || entity.endIndex === undefined) {
          const index = chunkText.indexOf(entity.text);
          return {
            ...entity,
            startIndex: index >= 0 ? index : 0,
            endIndex: index >= 0 ? index + entity.text.length : entity.text.length,
          };
        }
        return entity;
      });

      pceLogger.debug(`Extracted ${result.entities.length} entities and ${result.relationships.length} relationships`);

      return result;
    } catch (error: any) {
      pceLogger.error("Failed to extract entities", { error: error.message });
      throw error;
    }
  }

  /**
   * Batch extract from multiple chunks
   */
  async extractBatch(chunks: Array<{ text: string; id: string }>): Promise<Map<string, ExtractionResult>> {
    const results = new Map<string, ExtractionResult>();

    for (const chunk of chunks) {
      try {
        const result = await this.extract(chunk.text);
        results.set(chunk.id, result);
      } catch (error: any) {
        pceLogger.warn(`Failed to extract from chunk ${chunk.id}`, { error: error.message });
        results.set(chunk.id, { entities: [], relationships: [] });
      }
    }

    return results;
  }
}

