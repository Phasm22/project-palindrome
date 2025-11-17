# Pervasive Context Engine (PCE) - Phase I-A

## Overview

The Pervasive Context Engine (PCE) is a high-integrity, hybrid intelligence system designed to provide persistent, reliable situational awareness across complex, mutable IT/Security environments. Phase I-A establishes the foundation with vector MVP, data integrity, and simple RAG capabilities.

## Architecture

### Components

1. **Document Lifecycle Management (DLM)**
   - SHA-256 hashing for document integrity
   - Versioned snapshot log for change detection
   - Raw document storage for re-ingestion

2. **Security & Ingestion Pipeline**
   - Redaction pipeline with regex patterns
   - Document-type-aware chunking (Markdown runbooks, generic text)
   - ACL metadata tagging

3. **Vector Database**
   - Qdrant integration
   - OpenAI embeddings (text-embedding-3-small)
   - Indexation with metadata

4. **Core RAG & Orchestrator**
   - Semantic retrieval with access control
   - Generation layer with source provenance
   - Token budget management

## Setup

### Prerequisites

1. **Qdrant Vector Database**
   ```bash
   # Using Docker
   docker run -p 6333:6333 qdrant/qdrant
   ```

2. **Environment Variables**
   ```bash
   OPENAI_API_KEY=your_key_here
   QDRANT_URL=http://localhost:6333
   QDRANT_API_KEY=optional_api_key
   PCE_COLLECTION_NAME=pce_documents
   PCE_SNAPSHOT_LOG_PATH=./.pce/snapshots.json
   PCE_RAW_STORAGE_PATH=./.pce/raw-documents
   ```

### Installation

```bash
bun install
```

## Usage

### CLI

```bash
# Test redaction pipeline
bun run src/pce/cli.ts test-redaction

# Ingest a document
bun run src/pce/cli.ts ingest path/to/document.md markdown_runbook admin

# Query the RAG system
bun run src/pce/cli.ts query "What is the network topology?"

# Initialize vector store
bun run src/pce/cli.ts init
```

### Programmatic API

```typescript
import {
  SnapshotLog,
  RawDocumentStorage,
  Redactor,
  EmbeddingService,
  QdrantVectorStore,
  IngestionPipeline,
  RAGOrchestrator,
  RetrievalService,
  GenerationService,
} from "./pce";

// Initialize components
const snapshotLog = new SnapshotLog();
await snapshotLog.initialize();

const rawStorage = new RawDocumentStorage();
await rawStorage.initialize();

const redactor = new Redactor();
const embeddingService = new EmbeddingService();
const vectorStore = new QdrantVectorStore();
await vectorStore.initializeCollection(embeddingService.getDimension());

// Ingest document
const pipeline = new IngestionPipeline(
  snapshotLog,
  rawStorage,
  redactor,
  embeddingService,
  vectorStore
);

await pipeline.ingestFile("document.md", {
  documentType: "markdown_runbook",
  aclGroup: "admin",
  redact: true,
  reindex: false,
});

// Query
const retrievalService = new RetrievalService(vectorStore, embeddingService);
const generationService = new GenerationService();
const orchestrator = new RAGOrchestrator(retrievalService, generationService);

const response = await orchestrator.query("Your question", "admin");
console.log(response.answer);
```

## Testing

```bash
bun test tests/pce/
```

## Phase I-A Checklist Status

- ✅ Task 0.1: Minimal Logging Setup
- ✅ Task 1.1: SHA-256 Hashing
- ✅ Task 1.2: Versioned Snapshot Log
- ✅ Task 1.3: Change Detection Module
- ✅ Task 1.4: Raw Document Storage
- ✅ Task 2.1: Redaction Pipeline Setup
- ✅ Task 2.2: Document-Type-Aware Chunking
- ✅ Task 2.3: ACL Metadata Tagging
- ✅ Task 2.4: Redaction Unit-Test Harness
- ✅ Task 3.0: Vector Collection Schema
- ✅ Task 3.1: Vector DB Installation & Service Setup
- ✅ Task 3.2: Embedding Model Integration
- ✅ Task 3.3: Indexation Module
- ✅ Task 4.1: Simple Semantic Retrieval Path
- ✅ Task 4.1.1: Retrieval Parameters Config
- ✅ Task 4.2: Generation Layer Integration
- ✅ Task 4.3: Access Control Filter (V1)

## Next Steps

- Phase I-B: Enhanced retrieval strategies, multi-query expansion
- Phase I-C: Advanced access control, audit logging
- Phase II: Real-time updates, webhook integrations

