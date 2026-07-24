/**
 * Knowledge Graph - Main Module
 */

export * from "./schema";
export {
  DEFAULT_GRAPH_ENTITY_LABEL,
  GOLD_PATH_GRAPH_ENTITY_LABEL,
  PROVENANCE_AUDIT_GRAPH_ENTITY_LABEL,
} from "./graph-labels";
export { Neo4jGraphStore } from "./indexation/neo4j-client";
export { GraphIndexer, type GraphIndexationResult } from "./indexation/graph-indexer";
export { GraphQueryInterface, type GraphQueryResult } from "./queries/query-interface";
export type { GraphNode, GraphRelationship, EntityAttributes, OntologySchema } from "./schema/ontology";
