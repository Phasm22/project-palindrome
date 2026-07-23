import { expect, test } from "bun:test";
import type { HybridApiContext } from "../../src/agent/rag-client";
import { formatRagSummary } from "../../src/agent/runner";
import { SYSTEM_PROMPT } from "../../src/agent/system-prompt";

/**
 * Synthesis exploration: ensure constitution instructs the agent to use
 * RAG/CandidateAnswer and prior turns when answering.
 */
test("SYSTEM_PROMPT instructs agent to prefer or incorporate RAG/CandidateAnswer when it addresses the question", () => {
  expect(SYSTEM_PROMPT).toContain("When RAG context or CandidateAnswer clearly addresses the question");
  expect(SYSTEM_PROMPT).toContain("prefer or incorporate it in your reply");
});

test("SYSTEM_PROMPT instructs agent to synthesize retrieved context with tool results", () => {
  expect(SYSTEM_PROMPT).toContain("When you have both retrieved context and tool results");
  expect(SYSTEM_PROMPT).toContain("synthesize them into one coherent answer");
  expect(SYSTEM_PROMPT).toContain("do not ignore the provided context");
});

test("SYSTEM_PROMPT instructs agent to reuse prior answer for follow-ups when applicable", () => {
  expect(SYSTEM_PROMPT).toContain("follow-up that your previous answer already covers");
  expect(SYSTEM_PROMPT).toContain("summarize or refer back to it instead of re-querying tools");
});

test("formatRagSummary prefixes CandidateAnswer with explicit use/merge instruction", () => {
  const rag: HybridApiContext = {
    answer: "The cluster has three nodes: proxBig, yin, yang.",
    queryType: "HYBRID",
    fallbackMode: null,
    sources: [],
    metadata: { tokensUsed: 0, chunksRetrieved: 2 },
    context: {
      semanticChunks: [],
      structuralPaths: [],
      provenance: [],
    },
    sTotalScore: 0.7,
  };
  const summary = formatRagSummary(rag);
  expect(summary).toContain(
    "The following CandidateAnswer was generated from retrieved context. Use it when it answers the user's question; if you also call tools, combine it with tool results in your final answer."
  );
  expect(summary).toContain("CandidateAnswer=The cluster has three nodes");
});
