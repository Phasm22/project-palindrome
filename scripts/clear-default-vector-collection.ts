#!/usr/bin/env bun
/**
 * Clear the default PCE vector collection (pce_documents).
 * Use after isolation changes to remove old test data, then re-run ingestion.
 *
 * Run on host: bun run scripts/clear-default-vector-collection.ts
 * Or via Docker: docker compose run --rm clear-vector-store
 */

import { QdrantVectorStore } from "../src/pce/vector/qdrant-client";
import { EmbeddingService } from "../src/pce/vector/embeddings";
import { DEFAULT_COLLECTION } from "../src/pce/vector/collection-names";

async function main() {
  const embeddingService = new EmbeddingService();
  const vectorStore = new QdrantVectorStore();
  await vectorStore.initializeCollection(embeddingService.getDimension());
  await vectorStore.clearCollection();
  console.log(`Cleared default collection '${DEFAULT_COLLECTION}'. Re-run ingestion (e.g. pce:ingest-all) to repopulate.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
