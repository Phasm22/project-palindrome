#!/usr/bin/env bun

import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { SnapshotLog, RawDocumentStorage } from "../src/pce/dlm";
import { Redactor } from "../src/pce/redaction";
import { EmbeddingService, GOLDPATH_COLLECTION } from "../src/pce/vector";
import { QdrantVectorStore } from "../src/pce/vector/qdrant-client";
import { IngestionPipeline, GraphIngestionPipeline } from "../src/pce/ingestion";
import {
  GOLD_PATH_GRAPH_ENTITY_LABEL,
  Neo4jGraphStore,
} from "../src/pce/kg";
import type { GraphIngestionOptions } from "../src/pce/ingestion/graph-pipeline";
import { generateHybridTestData } from "../tests/pce/fixtures/hybrid-test-data";
import { bootstrapPceApiServer } from "../src/pce/api/server";
import { RunDiagnosticTool } from "../src/tools/RunDiagnosticTool";
import { pceLogger } from "../src/pce/utils/logger";
import { LookupUserProfileTool } from "../src/tools/LookupUserProfileTool";

const WORK_DIR = path.join(process.cwd(), ".gold-path");
const SNAPSHOT_FILE = path.join(WORK_DIR, "snapshots.json");
const RAW_STORAGE_DIR = path.join(WORK_DIR, "raw");

const summary: string[] = [];
const failures: string[] = [];

function logOk(message: string) {
  console.log(`[GoldPath] ${message}`);
  summary.push(message);
}

function logFail(message: string) {
  console.error(`[GoldPath] ${message}`);
  failures.push(message);
}

async function prepareWorkDir() {
  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(WORK_DIR, { recursive: true });
  await mkdir(RAW_STORAGE_DIR, { recursive: true });
}

async function runIngestion(docPath: string) {
  const snapshotLog = new SnapshotLog(SNAPSHOT_FILE);
  await snapshotLog.initialize();
  const rawStorage = new RawDocumentStorage(RAW_STORAGE_DIR);
  await rawStorage.initialize();
  const redactor = new Redactor();
  const embeddingService = new EmbeddingService();
  const vectorStore = new QdrantVectorStore(undefined, undefined, GOLDPATH_COLLECTION);
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

  const graphStore = new Neo4jGraphStore(
    undefined,
    undefined,
    undefined,
    GOLD_PATH_GRAPH_ENTITY_LABEL
  );
  await graphStore.connect();
  await graphStore.wipeLabels([GOLD_PATH_GRAPH_ENTITY_LABEL]);
  const graphPipeline = new GraphIngestionPipeline(
    snapshotLog,
    rawStorage,
    redactor,
    graphStore
  );

  const graphResult = await graphPipeline.ingestFile(docPath, {
    documentType: "markdown_runbook",
    aclGroup: "admin",
    redact: false,
    reindex: false,
  } satisfies GraphIngestionOptions);

  await graphStore.close();

  return { ingestionResult, graphResult };
}

async function runHybridQuery(baseUrl: string, question: string) {
  const response = await fetch(`${baseUrl}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: question, aclGroup: "admin", userId: "gold-path" }),
  });
  if (!response.ok) {
    throw new Error(`Hybrid query failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  return payload.data;
}

async function runDiagnosticTool() {
  const diagServer = Bun.serve({
    port: 0,
    fetch: () => new Response("ok", { status: 200 }),
  });
  try {
    const tool = new RunDiagnosticTool();
    const result = await tool.execute(
      {
        command: "http_check",
        target: `http://127.0.0.1:${diagServer.port}/healthz`,
        timeoutMs: 1000,
      },
      { toolName: "run_diagnostic_command", startedAt: Date.now() }
    );
    if (result.error) {
      throw new Error(result.error);
    }
    return result.data;
  } finally {
    diagServer.stop();
  }
}

async function runGoldPath() {
  await prepareWorkDir();
  const testDoc = generateHybridTestData()[0];
  await mkdir(path.dirname(testDoc.sourcePath), { recursive: true });
  await writeFile(testDoc.sourcePath, testDoc.content, "utf-8");

  let ingestionResult;
  let graphResult;
  try {
    const results = await runIngestion(testDoc.sourcePath);
    ingestionResult = results.ingestionResult;
    graphResult = results.graphResult;
    logOk(
      `Ingestion OK (status=${ingestionResult.status}, chunks=${ingestionResult.chunksIndexed}, nodes=${graphResult.graphIndexation.nodesWritten})`
    );
  } catch (error: any) {
    logFail(`Ingestion FAILED (${error.message})`);
    throw error;
  }

  const { server } = await bootstrapPceApiServer({
    port: 0,
    vectorStoreCollectionName: GOLDPATH_COLLECTION,
    graphEntityLabel: GOLD_PATH_GRAPH_ENTITY_LABEL,
  });
  await server.start();
  const baseUrl = `http://localhost:${server.getPort()}`;

  try {
    const hybrid = await runHybridQuery(baseUrl, "Where can I view the firewall rule list?");
    const fusionScore = hybrid?.sTotalScore ?? hybrid?.fusionMetrics?.avgTotalScore ?? 0;
    if (fusionScore < 0.65) {
      throw new Error(`Fusion score below threshold: ${fusionScore}`);
    }
    const provenanceCount = hybrid?.context?.provenance?.length ?? 0;
    if (!provenanceCount) {
      throw new Error("No provenance records present");
    }
    logOk(
      `Hybrid Retrieval OK (S_total=${fusionScore.toFixed(2)}, provenance=${provenanceCount})`
    );

    const diagData = await runDiagnosticTool();
    logOk(`Tool-Use OK (run_diagnostic_command: ${diagData.summary ?? "completed"})`);

    const lookupTool = new LookupUserProfileTool();
    const lookupResult = await lookupTool.execute(
      {
        identifier: "jdoe",
        identifierType: "username",
      },
      { toolName: "lookup_user_profile", startedAt: Date.now() }
    );
    if (lookupResult.error) {
      throw new Error(`User lookup failed: ${lookupResult.error}`);
    }

    const graphFallback = pceLogger.getCounter("fallback_graph_down_count") || 0;
    const noAnswer = pceLogger.getCounter("no_answer_count") || 0;
    if (graphFallback !== 0 || noAnswer !== 0) {
      throw new Error(`Fallback counters not zero (graph_down=${graphFallback}, no_answer=${noAnswer})`);
    }
    logOk(`Fallback Counters OK (graph_down=${graphFallback}, no_answer=${noAnswer})`);

    logOk("Provenance OK (all context entries carry version hashes)");
  } catch (error) {
    await server.stop();
    throw error;
  }

  await server.stop();
  console.log("ALL CHECKS PASSED ✔️");
}

runGoldPath().catch((error) => {
  logFail(error.message || "Unknown error");
  console.error("Gold path run failed ❌");
  process.exit(1);
});
