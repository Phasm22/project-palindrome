import type { TwinEntity } from "../twin/models/entities";
import type { TwinRelationship } from "../twin/models/relationships";

/**
 * Basic metadata captured whenever a parser runs.
 */
export interface ParserContext {
  /**
   * Identifier for the upstream tool or ingestion pipeline.
   * Example: "proxmox_readonly.list_nodes".
   */
  source: string;
  /**
    * When the upstream data was fetched.
    */
  collectedAt: Date;
}

export interface ParserResult {
  entities: TwinEntity[];
  relationships: TwinRelationship[];
  /**
   * Optional debug or provenance metadata that higher layers can persist.
   */
  metadata?: Record<string, unknown>;
}

export interface Parser<Input = unknown> {
  /**
   * Friendly name used for logging/metrics.
   */
  name: string;
  /**
   * Domain identifier, e.g., "compute", "network", "security".
   */
  domain: string;
  /**
   * Transform raw tool output into canonical entities.
   */
  parse(input: Input, context: ParserContext): Promise<ParserResult>;
}

