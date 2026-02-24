#!/usr/bin/env bun

import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { SnapshotLog, RawDocumentStorage } from "../src/pce/dlm";
import { Redactor } from "../src/pce/redaction";
import { EmbeddingService, AUDIT_COLLECTION } from "../src/pce/vector";
import { QdrantVectorStore } from "../src/pce/vector/qdrant-client";
import { IngestionPipeline, GraphIngestionPipeline } from "../src/pce/ingestion";
import { Neo4jGraphStore } from "../src/pce/kg";
import type { GraphIngestionOptions } from "../src/pce/ingestion/graph-pipeline";
import { generateHybridTestData } from "../tests/pce/fixtures/hybrid-test-data";
import { bootstrapPceApiServer } from "../src/pce/api/server";

const WORK_DIR = path.join(process.cwd(), ".provenance-audit");
const SNAPSHOT_FILE = path.join(WORK_DIR, "snapshots.json");
const RAW_STORAGE_DIR = path.join(WORK_DIR, "raw");

function logOk(message: string) {
  console.log(`[Provenance] ${message}`);
}

function logFail(message: string) {
  console.error(`[Provenance] ${message}`);
}

async function prepareWorkDir() {
  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(RAW_STORAGE_DIR, { recursive: true });
}

async function runIngestion(docPath: string) {
  const snapshotLog = new SnapshotLog(SNAPSHOT_FILE);
  await snapshotLog.initialize();
  const rawStorage = new RawDocumentStorage(RAW_STORAGE_DIR);
  await rawStorage.initialize();
  const redactor = new Redactor();
  const embeddingService = new EmbeddingService();
  const vectorStore = new QdrantVectorStore(undefined, undefined, AUDIT_COLLECTION);

  // Clear scratch collection only (never production pce_documents)
  await vectorStore.clearCollection();

  await vectorStore.initializeCollection(embeddingService.getDimension());
  const ingestionPipeline = new IngestionPipeline(
    snapshotLog,
    rawStorage,
    redactor,
    embeddingService,
    vectorStore
  );

  const ingestionResult = await ingestionPipeline.ingestFile(docPath, {
    documentType: "markdown_runbook",
    aclGroup: "admin",
    redact: false,
    reindex: true,
  });

  const changeHash = snapshotLog.getSnapshot(docPath)?.sha256Hash ?? null;

  const graphStore = new Neo4jGraphStore();
  await graphStore.connect();
  
  // Clear graph store for test isolation
  await graphStore.wipeAll();
  
  const graphPipeline = new GraphIngestionPipeline(
    snapshotLog,
    rawStorage,
    redactor,
    graphStore
  );

  await graphPipeline.ingestFile(docPath, {
    documentType: "markdown_runbook",
    aclGroup: "admin",
    redact: false,
    reindex: true,
  } satisfies GraphIngestionOptions);

  await graphStore.close();

  if (!changeHash) {
    throw new Error("Unable to read version hash from snapshot log");
  }

  return { ingestionResult, versionHash: changeHash };
}

async function runApiQuery(baseUrl: string, query: string) {
  const response = await fetch(`${baseUrl}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, aclGroup: "admin", userId: "provenance-audit" }),
  });

  if (!response.ok) {
    throw new Error(`Query failed: HTTP ${response.status}`);
  }
  const payload: any = await response.json();
  return payload.data;
}

export async function runProvenanceAudit() {
  await prepareWorkDir();
  const fixtures = generateHybridTestData();
  if (!fixtures.length) {
    throw new Error("No hybrid fixtures available for provenance audit");
  }
  const fixture = fixtures[0]!;
  await mkdir(path.dirname(fixture.sourcePath), { recursive: true });
  await writeFile(fixture.sourcePath, fixture.content, "utf-8");

  let versionHash: string;
  try {
    const ingestionOutcome = await runIngestion(fixture.sourcePath);
    versionHash = ingestionOutcome.versionHash;
    logOk(
      `Ingestion OK (status=${ingestionOutcome.ingestionResult.status}, chunks=${ingestionOutcome.ingestionResult.chunksIndexed})`
    );
  } catch (error: any) {
    logFail(`Ingestion FAILED (${error.message})`);
    throw error;
  }

  const { server } = await bootstrapPceApiServer({
    port: 0,
    vectorStoreCollectionName: AUDIT_COLLECTION,
    fusionConfig: {
      minTotalScore: 0.5,
    },
  });
  await server.start();
  const baseUrl = `http://localhost:${server.getPort()}`;

  const queries = [
    "Which host runs the http-service?",
    "Where is host-web-01 documented?",
    "Which service depends on mysql-service?",
  ];

  try {
    let result: any = null;
    for (const question of queries) {
      result = await runApiQuery(baseUrl, question);
      if ((result?.sources?.length ?? 0) > 0 || (result?.context?.provenance?.length ?? 0) > 0) {
        logOk(`Query succeeded with '${question}'`);
        break;
      }
    }

    const provenanceIssues: string[] = [];
    const sources = result?.sources ?? [];
    if (!sources.length) {
      logOk("No top-level sources returned; relying on fused context for provenance validation");
    } else {
      for (const source of sources) {
        if (!source.versionHash) {
          logOk(`Skipping non-document source ${source.sourcePath}`);
          continue;
        }
        if (source.versionHash !== versionHash) {
          provenanceIssues.push(`Source ${source.sourcePath} missing expected version hash`);
        }
      }
    }

    const contextProvenance = result?.context?.provenance ?? [];
    if (!contextProvenance.length) {
      provenanceIssues.push("Context provenance array is empty");
    } else {
      for (const entry of contextProvenance) {
        if (entry.versionHash !== versionHash) {
          provenanceIssues.push(`Provenance entry ${entry.sourcePath} mismatch`);
        }
      }
    }

    const semanticChunks = (result?.context?.semanticChunks ?? []) as Array<any>;
    for (const item of semanticChunks) {
      if (item.versionHash !== versionHash) {
        provenanceIssues.push(`Chunk ${item.id} version hash mismatch`);
      }
    }

    if (provenanceIssues.length) {
      provenanceIssues.forEach((issue) => logFail(issue));
      throw new Error("Provenance validation failed");
    }

    logOk(`Provenance OK (all sources mapped to version ${versionHash})`);
    logOk(`Semantic chunks verified: ${semanticChunks.length}, provenance entries: ${contextProvenance.length}`);
    console.log("PROVENANCE AUDIT PASSED ✔️");
  } catch (error) {
    await server.stop();
    throw error;
  }

  await server.stop();
}

if (import.meta.main) {
  runProvenanceAudit().catch((error) => {
    logFail(error.message || "Unknown error");
    console.error("Provenance audit failed ❌");
    process.exit(1);
  });
}
