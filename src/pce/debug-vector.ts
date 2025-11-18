#!/usr/bin/env bun

/**
 * Debug Vector Retrieval
 * Tests vector similarity for a given query to diagnose RAG retrieval issues
 */

import { EmbeddingService } from "./vector/embeddings";
import { QdrantVectorStore } from "./vector/qdrant-client";
import { pceLogger } from "./utils/logger";

async function debugVector(query: string) {
  console.log(`\n🔍 Debugging Vector Retrieval for: "${query}"\n`);

  // Initialize services
  const embeddingService = new EmbeddingService();
  const vectorStore = new QdrantVectorStore();

  // Check embedding model
  const model = (embeddingService as any).model || process.env.PCE_EMBEDDING_MODEL || "text-embedding-3-small";
  console.log(`📊 Embedding Model: ${model}`);
  console.log(`📏 Embedding Dimension: ${embeddingService.getDimension()}\n`);

  // Generate query embedding
  console.log("1️⃣  Generating query embedding...");
  const queryEmbedding = await embeddingService.embed(query);
  console.log(`   ✓ Generated embedding (${queryEmbedding.length} dimensions)\n`);

  // Search vector store
  console.log("2️⃣  Searching vector store...");
  const collectionName = (vectorStore as any).collectionName || "pce_documents";
  
  try {
    const client = (vectorStore as any).client;
    
    // Search with low threshold to see all results
    const searchResult = await client.search(collectionName, {
      vector: queryEmbedding,
      limit: 10,
      score_threshold: 0.0, // No threshold - show all results
      with_payload: true,
    });

    console.log(`   ✓ Found ${searchResult.length} results\n`);

    if (searchResult.length === 0) {
      console.log("❌ NO RESULTS FOUND");
      console.log("\nPossible causes:");
      console.log("  - No data indexed in vector store");
      console.log("  - Embedding model mismatch (ingestion vs query)");
      console.log("  - Collection name mismatch");
      return;
    }

    // Display results
    console.log("3️⃣  Top Results (sorted by similarity):\n");
    searchResult.forEach((result: any, index: number) => {
      const score = result.score || 0;
      const payload = result.payload || {};
      const text = payload.text || "";
      const sourcePath = payload.source_path || "unknown";
      const aclGroup = payload.acl_group || "unknown";
      const versionHash = payload.version_hash || "unknown";

      console.log(`   Result #${index + 1}:`);
      const currentThreshold = 0.15; // Updated threshold
      console.log(`   ├─ Similarity Score: ${score.toFixed(4)} ${score >= currentThreshold ? "✅" : `⚠️  (below ${currentThreshold} threshold)`}`);
      console.log(`   ├─ Source: ${sourcePath}`);
      console.log(`   ├─ ACL Group: ${aclGroup}`);
      console.log(`   ├─ Version Hash: ${versionHash.substring(0, 16)}...`);
      console.log(`   └─ Text Preview: ${text.substring(0, 100)}${text.length > 100 ? "..." : ""}`);
      console.log("");
    });

    // Analyze scores
    const scores = searchResult.map((r: any) => r.score || 0);
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);
    const avgScore = scores.reduce((a: number, b: number) => a + b, 0) / scores.length;

    // Get actual threshold from fusion config (default 0.15)
    const currentThreshold = 0.15; // Updated threshold for structural documents

    console.log("4️⃣  Score Analysis:\n");
    console.log(`   Max Score: ${maxScore.toFixed(4)}`);
    console.log(`   Min Score: ${minScore.toFixed(4)}`);
    console.log(`   Avg Score: ${avgScore.toFixed(4)}`);
    console.log(`   Threshold: ${currentThreshold} (minVectorScore - adjusted for structural docs)`);
    console.log(`   Results above threshold: ${scores.filter((s: number) => s >= currentThreshold).length}/${scores.length}`);

    if (maxScore < currentThreshold) {
      console.log("\n⚠️  WARNING: All scores below threshold!");
      console.log("   This suggests:");
      console.log("   - Query doesn't match indexed content well");
      console.log("   - Embedding model mismatch");
      console.log("   - Threshold too strict for this data type");
    } else if (maxScore >= currentThreshold) {
      console.log("\n✅ Some results above threshold - RAG should work");
    }

  } catch (error: any) {
    console.error(`\n❌ Error searching vector store: ${error.message}`);
    console.error("\nPossible causes:");
    console.error("  - Vector store not initialized");
    console.error("  - Collection doesn't exist");
    console.error("  - Connection error");
  }
}

// Main
const query = process.argv[2] || "aiMarketBot";
debugVector(query).catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

