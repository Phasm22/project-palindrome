import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { queryPCE } from "../../src/agent/pce-client";

describe("PCE Client", () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env.PCE_API_URL;
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (originalEnv) {
      process.env.PCE_API_URL = originalEnv;
    } else {
      delete process.env.PCE_API_URL;
    }
  });

  test("queryPCE sends correct request format", async () => {
    const mockResponse = {
      success: true,
      data: {
        answer: "Test answer",
        queryType: "semantic" as const,
        fallbackMode: null,
        sources: [],
        metadata: { tokensUsed: 100, chunksRetrieved: 5 },
        context: {
          semanticChunks: [],
          structuralPaths: [],
          provenance: { versionHashes: [], timestamps: [] },
        },
        sTotalScore: 0.85,
      },
    };

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await queryPCE("test-user", "test query");

    expect(fetchSpy).toHaveBeenCalled();
    const callArgs = fetchSpy.mock.calls[0];
    expect(callArgs[0]).toContain("/query");
    expect(callArgs[1].method).toBe("POST");
    expect(callArgs[1].headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(callArgs[1].body)).toMatchObject({
      userId: "test-user",
      query: "test query",
      aclGroup: "viewer",
    });

    expect(result.answer).toBe("Test answer");
    expect(result.sTotalScore).toBe(0.85);
  });

  test("queryPCE handles API errors", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    await expect(queryPCE("test-user", "test query")).rejects.toThrow("PCE error: 500");
  });

  test("queryPCE handles API error responses", async () => {
    const mockErrorResponse = {
      success: false,
      error: "Rate limit exceeded",
    };

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => mockErrorResponse,
    });

    await expect(queryPCE("test-user", "test query")).rejects.toThrow("PCE API error: Rate limit exceeded");
  });

  test("queryPCE uses default PCE_API_URL", async () => {
    // Note: PCE_API_URL is evaluated at import time, so we test the default behavior
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          answer: "Test",
          queryType: "semantic" as const,
          fallbackMode: null,
          sources: [],
          metadata: { tokensUsed: 0, chunksRetrieved: 0 },
          context: {
            semanticChunks: [],
            structuralPaths: [],
            provenance: { versionHashes: [], timestamps: [] },
          },
          sTotalScore: null,
        },
      }),
    });

    await queryPCE("test-user", "test");

    expect(fetchSpy).toHaveBeenCalled();
    const callArgs = fetchSpy.mock.calls[0];
    // Should use default URL (localhost:3000) or env var if set before import
    expect(callArgs[0]).toMatch(/http:\/\/.*\/query/);
  });
});

