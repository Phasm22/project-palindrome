#!/usr/bin/env bun
// Test Qdrant filter with exact API code

import { QdrantClient } from "@qdrant/js-client-rest";
import { EmbeddingService } from "../src/pce/vector/embedding-service";

const client = new QdrantClient({ url: "http://localhost:6333" });
const collection = "pce_documents";
const embeddingService = new EmbeddingService();

async function testFilter() {
  console.log("Testing Qdrant filter with exact API code...\n");
  
  // Generate query embedding
  const query = "what is aiMarketBot?";
  const queryVector = await embeddingService.embedText(query);
  console.log(`Query: "${query}"`);
  console.log(`Embedding dimension: ${queryVector.length}\n`);
  
  // Build filter exactly as the API does
  const aclGroup = "ops";
  const searchFilter = {
    must: [
      {
        key: "acl_group",
        match: { value: aclGroup },
      },
    ],
  };
  
  console.log("Filter being applied:");
  console.log(JSON.stringify(searchFilter, null, 2));
  console.log();
  
  // Search with filter
  const searchParams: any = {
    vector: queryVector,
    limit: 5,
    with_payload: true,
  };
  
  if (searchFilter) {
    searchParams.filter = searchFilter;
  }
  
  console.log("Search params:");
  console.log(JSON.stringify({ ...searchParams, vector: `[${queryVector.length} dimensions]` }, null, 2));
  console.log();
  
  try {
    const results = await client.search(collection, searchParams);
    console.log(`✅ Found ${results.length} results with filter`);
    
    if (results.length > 0) {
      console.log("\nSample result:");
      const first = results[0];
      console.log(`  Score: ${first.score}`);
      console.log(`  Payload keys: ${Object.keys(first.payload || {}).join(", ")}`);
      console.log(`  acl_group: ${(first.payload as any)?.acl_group}`);
      console.log(`  Text preview: ${((first.payload as any)?.text || "").substring(0, 100)}...`);
    } else {
      console.log("\n❌ No results found with filter");
      
      // Try without filter
      console.log("\nTrying without filter...");
      const resultsNoFilter = await client.search(collection, {
        vector: queryVector,
        limit: 5,
        with_payload: true,
      });
      console.log(`Found ${resultsNoFilter.length} results without filter`);
      
      if (resultsNoFilter.length > 0) {
        console.log("\nSample result (no filter):");
        const first = resultsNoFilter[0];
        console.log(`  Score: ${first.score}`);
        console.log(`  acl_group: ${(first.payload as any)?.acl_group}`);
        console.log(`  source_path: ${(first.payload as any)?.source_path}`);
      }
    }
  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`);
    console.error(error);
  }
}

testFilter().catch(console.error);
