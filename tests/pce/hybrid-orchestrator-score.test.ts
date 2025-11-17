import { describe, it, expect } from "bun:test";
import { HybridOrchestrator } from "../../src/pce/rag/hybrid-orchestrator";
import { FusionEngine } from "../../src/pce/rag/fusion";
import type {
  ACLGroup,
  DocumentChunk,
  GraphRetrievalResult,
  HybridContext,
  QueryAnalysis,
  QueryType,
  RetrievalResult,
} from "../../src/pce/types";

class StubQueryAnalyzer {
  private type: QueryType;

  constructor(type: QueryType) {
    this.type = type;
  }

  async analyzeQuery(): Promise<QueryAnalysis> {
    return {
      queryType: this.type,
      entities: [],
      structuralIndicators: [],
    };
  }
}

class StubRetrievalService {
  private result: RetrievalResult;

  constructor(result: RetrievalResult) {
    this.result = result;
  }

  async retrieve(): Promise<RetrievalResult> {
    return this.result;
  }
}

class StubGraphRetrieval {
  private result: GraphRetrievalResult | null;
  private shouldThrow: boolean;

  constructor(result: GraphRetrievalResult | null, shouldThrow = false) {
    this.result = result;
    this.shouldThrow = shouldThrow;
  }

  async retrieve() {
    if (this.shouldThrow) {
      throw new Error("Graph unavailable");
    }
    if (!this.result) {
      return {
        entities: [],
        relationships: [],
        provenance: [],
      };
    }
    return this.result;
  }
}

class StubGenerationService {
  async generate(query: string, chunks: DocumentChunk[]) {
    return {
      answer: `Answer for ${query}`,
      sources: chunks.map((chunk) => ({
        chunkId: chunk.id,
        sourcePath: chunk.metadata.sourcePath,
        score: 1,
        text: chunk.text,
      })),
      metadata: {
        tokensUsed: 0,
        chunksRetrieved: chunks.length,
      },
    };
  }
}

function makeChunk(id: string, text: string): DocumentChunk {
  return {
    id,
    text,
    metadata: {
      versionHash: "hash-123",
      aclGroup: "admin" as ACLGroup,
      sourceType: "markdown_runbook",
      sourcePath: `/tmp/${id}.md`,
      timestamp: new Date("2024-01-01T00:00:00Z"),
      chunkIndex: 0,
      totalChunks: 1,
    },
    startIndex: 0,
    endIndex: text.length,
  };
}

describe("HybridOrchestrator score unification", () => {
  it("uses max vector score for semantic-only queries", async () => {
    const chunk = makeChunk("chunk-1", "Firewall rules are stored at /etc/firewall/rules.conf");
    const retrievalResult: RetrievalResult = {
      chunks: [chunk],
      scores: [0.42],
      queryEmbedding: [],
    };

    const orchestrator = new HybridOrchestrator(
      new StubQueryAnalyzer("SEMANTIC_ONLY"),
      new StubRetrievalService(retrievalResult),
      new StubGraphRetrieval(null),
      new FusionEngine(),
      new StubGenerationService()
    );

    const response = await orchestrator.query("Where are the firewall rules?", "admin");

    expect(response.queryType).toBe("SEMANTIC_ONLY");
    expect(response.sTotalScore).toBeCloseTo(0.42, 5);
  });

  it("applies structural path score for structural-primary queries", async () => {
    const graphResult: GraphRetrievalResult = {
      entities: [
        {
          id: "host-web-01",
          type: "Host",
          attributes: {},
          confidence: 0.8,
        },
      ],
      relationships: [],
      provenance: [{ versionHash: "hash-123", sourcePath: "/tmp/prov.md" }],
    };

    const orchestrator = new HybridOrchestrator(
      new StubQueryAnalyzer("STRUCTURAL_PRIMARY"),
      new StubRetrievalService({ chunks: [], scores: [], queryEmbedding: [] }),
      new StubGraphRetrieval(graphResult),
      new FusionEngine(),
      new StubGenerationService()
    );

    const response = await orchestrator.query("Show connections for host-web-01", "admin");

    expect(response.queryType).toBe("STRUCTURAL_PRIMARY");
    expect(response.sTotalScore).toBeCloseTo(1, 5);
    expect(response.context?.structuralPaths.length).toBe(1);
  });

  it("uses semantic score when graph retrieval fails (fallback)", async () => {
    const chunk = makeChunk("chunk-2", "Firewall lists documented at /ui/firewall/rules");
    const retrievalResult: RetrievalResult = {
      chunks: [chunk],
      scores: [0.67],
      queryEmbedding: [],
    };

    const orchestrator = new HybridOrchestrator(
      new StubQueryAnalyzer("STRUCTURAL_PRIMARY"),
      new StubRetrievalService(retrievalResult),
      new StubGraphRetrieval(null, true),
      new FusionEngine(),
      new StubGenerationService()
    );

    const response = await orchestrator.query("Show firewall docs", "admin");

    expect(response.queryType).toBe("SEMANTIC_ONLY");
    expect(response.fallbackMode).toBe("graph_down");
    expect(response.sTotalScore).toBeCloseTo(0.67, 5);
  });
});
