export const DEFAULT_GRAPH_ENTITY_LABEL = "Entity";
export const GOLD_PATH_GRAPH_ENTITY_LABEL = "GoldPathEntity";
export const PROVENANCE_AUDIT_GRAPH_ENTITY_LABEL = "ProvenanceAuditEntity";

const CYPHER_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function toCypherLabel(label: string): string {
  if (!CYPHER_IDENTIFIER_PATTERN.test(label)) {
    throw new Error(`Invalid Neo4j label: ${label}`);
  }
  return `\`${label}\``;
}
