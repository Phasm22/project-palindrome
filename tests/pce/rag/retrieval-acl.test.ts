import { describe, it, expect } from "bun:test";
import { RetrievalService } from "../../../src/pce/rag/retrieval";

class StubVectorStore {
  async search() {
    return [];
  }

  async probeAccessGroups() {
    return ["admin", "ops"];
  }
}

class StubEmbeddingService {
  async embed() {
    return [0.1, 0.2, 0.3];
  }
}

describe("RetrievalService ACL enforcement", () => {
  it("flags access denied when matches exist for other ACL groups", async () => {
    const retrieval = new RetrievalService(
      new StubVectorStore() as any,
      new StubEmbeddingService() as any
    );

    const result = await retrieval.retrieve("where", "viewer");

    expect(result.accessDeniedInfo).toBeDefined();
    expect(result.accessDeniedInfo?.reason).toBe("SEMANTIC_ACL_FILTERED");
    expect(result.accessDeniedInfo?.matchedCount).toBeGreaterThan(0);
  });

  it("allows privileged users to bypass the ACL block", async () => {
    const retrieval = new RetrievalService(
      new StubVectorStore() as any,
      new StubEmbeddingService() as any
    );

    const result = await retrieval.retrieve("where", "admin");

    expect(result.accessDeniedInfo).toBeUndefined();
  });
});
