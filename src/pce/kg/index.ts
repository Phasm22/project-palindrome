/**
 * Knowledge Graph - Main Module
 */

export * from "./schema";
export { Neo4jGraphStore } from "./indexation/neo4j-client";
export { GraphIndexer, type GraphIndexationResult } from "./indexation/graph-indexer";
export { GraphQueryInterface, type GraphQueryResult } from "./queries/query-interface";
export type { GraphNode, GraphRelationship, EntityAttributes, OntologySchema } from "./schema/ontology";

