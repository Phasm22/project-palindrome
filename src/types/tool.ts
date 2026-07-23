import type { Domain } from "../reasoning/domain-taxonomy";

export type ToolCall = {
  toolName: string;
  parameters: Record<string, any>;
};

/** Classification behavior owned by one tool for one domain. */
export type ToolDomainClassification = {
  domain: Domain;
  /** Deterministic fallback-classifier triggers, ordered by priority. */
  triggerPatterns?: readonly RegExp[];
  /** Positive parity probes used to verify primary/fallback domain coverage. */
  classificationExamples?: readonly string[];
  /** Tokens used to validate that retrieved source paths match this domain. */
  retrievalKeywords?: readonly string[];
  /** Prefer live tools over retrieval for simple read queries in this domain. */
  toolFirst?: boolean;
  /** This tool may participate in a multi-domain/composite query. */
  compositeEligible?: boolean;
  /** Higher-priority domains are tested first when triggers overlap. */
  priority?: number;
};

export type ToolMetadata = {
  name: string;
  description: string;
  categories?: string[];
  parameters?: Record<string, any>;
  allowedAcls?: string[];
  risk?: "low" | "medium" | "high";
  requiresConfirmation?: boolean;
  /** Colocated intent-classification registration for this tool. */
  classification?: readonly ToolDomainClassification[];
};
