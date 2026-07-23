import { TEST_COLLECTION } from "../../src/pce/vector";

export function buildIsolatedQdrantCollectionName(label: string): string {
  return `${TEST_COLLECTION}_${label.replace(/[^a-z0-9_]+/gi, "_").toLowerCase()}`;
}

let qdrantCollectionCounter = 0;

export function buildUniqueQdrantCollectionName(label: string): string {
  qdrantCollectionCounter += 1;
  return `${buildIsolatedQdrantCollectionName(label)}_${process.pid}_${qdrantCollectionCounter}`;
}
