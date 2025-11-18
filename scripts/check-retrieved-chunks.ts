#!/usr/bin/env bun
// Check what chunks are actually being retrieved for a query

import { EmbeddingService } from "../src/pce/vector/embedding-service";
import { QdrantVectorStore } from "../src/pce/vector/qdrant-client";

const embeddingService = new EmbeddingService();
const vectorStore = new QdrantVectorStore();

async function checkChunks() {
  await vectorStore.initializeCollection(embeddingService.getDimension());
  
  const query = "what is aiMarketBot?";
  console.log(`Query: "${query}"\n`);
  
  const queryEmbedding = await embeddingService.embedText(query);
  
  const results = await vectorStore.search(
    queryEmbedding,
    5,
    "lab-admin"
  );
  
  console.log(`Found ${results.length} chunks:\n`);
  
  results.forEach((result, i) => {
    console.log(`Chunk ${i + 1} (score: ${result.score.toFixed(4)}):`);
    console.log(`  Source: ${result.chunk.metadata.sourcePath}`);
    console.log(`  Text: ${result.chunk.text.substring(0, 200)}...`);
    console.log();
  });
  
  // Also check if "aiMarketBot" appears in any chunks
  const matchingChunks = results.filter(r => 
    r.chunk.text.toLowerCase().includes("aimarketbot") ||
    r.chunk.text.toLowerCase().includes("ai market bot")
  );
  
  console.log(`Chunks containing "aiMarketBot": ${matchingChunks.length}`);
}

checkChunks().catch(console.error);
