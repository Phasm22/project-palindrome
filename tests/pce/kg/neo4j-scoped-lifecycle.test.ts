import { describe, expect, test } from "bun:test";
import type { Driver } from "neo4j-driver";
import {
  GOLD_PATH_GRAPH_ENTITY_LABEL,
  PROVENANCE_AUDIT_GRAPH_ENTITY_LABEL,
} from "../../../src/pce/kg/graph-labels";
import { Neo4jGraphStore } from "../../../src/pce/kg/indexation/neo4j-client";
import { GraphQueryInterface } from "../../../src/pce/kg/queries/query-interface";
import { NodeType } from "../../../src/pce/kg/schema/ontology";

type CypherCall = {
  query: string;
  parameters?: Record<string, unknown>;
};

function capturedDriver(calls: CypherCall[]): Driver {
  const session = {
    run: async (query: string, parameters?: Record<string, unknown>) => {
      calls.push({ query, parameters });
      return { records: [] };
    },
    close: async () => {},
  };
  const driver = {
    session: () => session,
  } as unknown as Driver;

  return driver;
}

function graphStoreWithCapturedCypher(
  calls: CypherCall[],
  entityLabel?: string
): Neo4jGraphStore {
  const driver = capturedDriver(calls);
  const graphStore = entityLabel
    ? new Neo4jGraphStore(undefined, undefined, undefined, entityLabel)
    : new Neo4jGraphStore();

  (graphStore as unknown as { driver: Driver }).driver = driver;
  return graphStore;
}

describe("Neo4j scoped lifecycle", () => {
  test("wipeLabels issues a parameterized label-scoped delete", async () => {
    const calls: CypherCall[] = [];
    const graphStore = graphStoreWithCapturedCypher(calls);

    await graphStore.wipeLabels([
      GOLD_PATH_GRAPH_ENTITY_LABEL,
      PROVENANCE_AUDIT_GRAPH_ENTITY_LABEL,
      GOLD_PATH_GRAPH_ENTITY_LABEL,
    ]);

    expect(calls).toHaveLength(1);
    const normalizedCypher = calls[0]!.query.replace(/\s+/g, " ").trim();
    expect(normalizedCypher).toContain(
      "WHERE any(nodeLabel IN labels(n) WHERE nodeLabel IN $labels)"
    );
    expect(normalizedCypher).toContain("DETACH DELETE n");
    expect(normalizedCypher).not.toBe("MATCH (n) DETACH DELETE n");
    expect(calls[0]!.parameters).toEqual({
      labels: [
        GOLD_PATH_GRAPH_ENTITY_LABEL,
        PROVENANCE_AUDIT_GRAPH_ENTITY_LABEL,
      ],
    });
  });

  test("wipeLabels rejects an undeclared empty boundary", async () => {
    const graphStore = graphStoreWithCapturedCypher([]);

    expect(graphStore.wipeLabels([])).rejects.toThrow(
      "wipeLabels requires at least one non-empty label"
    );
  });

  test("scratch labels isolate graph writes and reads from production Entity nodes", async () => {
    const writeCalls: CypherCall[] = [];
    const graphStore = graphStoreWithCapturedCypher(
      writeCalls,
      GOLD_PATH_GRAPH_ENTITY_LABEL
    );

    await graphStore.writeNode({
      id: "host-web-01",
      type: NodeType.HOST,
      attributes: { hostname: "host-web-01" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const normalizedWrite = writeCalls[0]!.query.replace(/\s+/g, " ").trim();
    expect(normalizedWrite).toContain("MERGE (n:`GoldPathEntity` {id: $id})");
    expect(normalizedWrite).not.toContain("(n:Entity");

    const readCalls: CypherCall[] = [];
    const queryInterface = new GraphQueryInterface(
      capturedDriver(readCalls),
      GOLD_PATH_GRAPH_ENTITY_LABEL
    );
    await queryInterface.getEntitiesByType("Host");

    const normalizedRead = readCalls[0]!.query.replace(/\s+/g, " ").trim();
    expect(normalizedRead).toContain(
      "MATCH (n:`GoldPathEntity` {type: $type})"
    );
    expect(normalizedRead).not.toContain("(n:Entity");

    await queryInterface.executeQuery(
      "MATCH (n:Entity)-[r]->(connected:Entity) RETURN n, r, connected"
    );
    const normalizedRawRead = readCalls[1]!.query.replace(/\s+/g, " ").trim();
    expect(normalizedRawRead).toContain(
      "MATCH (n:`GoldPathEntity`)-[r]->(connected:`GoldPathEntity`)"
    );
    expect(normalizedRawRead).not.toContain(":Entity");
  });

  test("health-check scripts use scratch labels and avoid global graph wipes", async () => {
    const scriptContracts = [
      {
        path: "scripts/run-gold-path.ts",
        label: "GOLD_PATH_GRAPH_ENTITY_LABEL",
      },
      {
        path: "scripts/run-provenance-audit.ts",
        label: "PROVENANCE_AUDIT_GRAPH_ENTITY_LABEL",
      },
    ];

    for (const contract of scriptContracts) {
      const source = await Bun.file(contract.path).text();
      const graphIngestionCall = source.match(
        /graphPipeline\.ingestFile\([\s\S]*?\}\s+satisfies GraphIngestionOptions\)/
      )?.[0];

      expect(source).not.toContain(".wipeAll(");
      expect(source).toContain(`wipeLabels([${contract.label}])`);
      expect(source).toContain(`graphEntityLabel: ${contract.label}`);
      expect(graphIngestionCall).toContain("reindex: false");
      expect(graphIngestionCall).not.toContain("reindex: true");
    }
  });
});
