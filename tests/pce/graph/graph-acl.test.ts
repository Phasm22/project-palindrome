import { describe, it, expect } from "bun:test";
import { GraphRAGRetrieval } from "../../../src/pce/graph-retrieval/graph-rag";
import type { GraphQueryInterface, GraphQueryResult } from "../../../src/pce/kg/queries/query-interface";

const sampleGraph: GraphQueryResult = {
  nodes: [
    {
      id: "viewer-host",
      type: "Host",
      attributes: {},
      versionHash: "v1",
      sourcePath: "/viewer",
      aclGroup: "viewer",
    },
    {
      id: "admin-host",
      type: "Host",
      attributes: {},
      versionHash: "v2",
      sourcePath: "/admin",
      aclGroup: "admin",
    },
  ],
  relationships: [
    {
      from: "viewer-host",
      to: "admin-host",
      type: "CONNECTS_TO",
      versionHash: "r1",
      sourcePath: "/admin",
      aclGroup: "admin",
    },
  ],
  paths: [
    {
      nodes: ["viewer-host", "admin-host"],
      relationships: ["CONNECTS_TO"],
    },
  ],
};

const queryInterface = {
  getEntitiesByType: async () => sampleGraph,
  findEntitiesByIdOrName: async () => sampleGraph,
  findAlertsAffectingHost: async () => sampleGraph,
  findHostsConnectedToService: async () => sampleGraph,
  findPath: async () => sampleGraph,
  findDependencies: async () => sampleGraph,
  findDependents: async () => sampleGraph,
  findDependencyChain: async () => sampleGraph,
  executeQuery: async () => sampleGraph,
  getEntitiesWithProvenance: async () => [],
} as unknown as GraphQueryInterface;

describe("GraphRAGRetrieval ACL pruning", () => {
  it("removes unauthorized nodes and paths for viewers", async () => {
    const retrieval = new GraphRAGRetrieval(queryInterface);

    const result = await retrieval.retrieve("show hosts", "entities", "viewer");

    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].id).toBe("viewer-host");
    expect(result.relationships).toHaveLength(0);
    expect(result.paths?.length ?? 0).toBe(0);
  });

  it("keeps full context for admins", async () => {
    const retrieval = new GraphRAGRetrieval(queryInterface);

    const result = await retrieval.retrieve("show hosts", "entities", "admin");

    expect(result.entities).toHaveLength(2);
    expect(result.relationships).toHaveLength(1);
    expect(result.paths?.length ?? 0).toBe(1);
  });
});
