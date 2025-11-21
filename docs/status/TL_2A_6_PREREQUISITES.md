# TL-2A.6 Prerequisites Check

## ✅ Step 1: Ingestion Pipeline Locations

**Confirmed:**
- ✅ `src/pce/ingestion/pipeline.ts` - Main vector ingestion pipeline
- ✅ `src/pce/ingestion/graph-pipeline.ts` - Graph ingestion pipeline  
- ✅ `src/pce/vector/embeddings.ts` - Embedding service
- ✅ `src/pce/vector/qdrant-client.ts` - Vector store client
- ✅ `src/pce/kg/schema/` - Knowledge graph schema
- ✅ `src/pce/kg/indexation/` - Graph indexation

**Status:** All required directories and files exist ✅

---

## ✅ Step 2: Redaction Pipeline Wired

**Confirmed:**
- ✅ `pipeline.ts` line ~40: `const redactionResult = this.redactor.redact(fileContent);`
- ✅ `graph-pipeline.ts` line ~60: `const redactionResult = this.redactor.redact(fileContent);`
- ✅ Redaction happens BEFORE chunking/embedding in both pipelines

**Status:** Redaction is properly wired in front of vector ingestion ✅

---

## ✅ Step 3: Proxmox Document Entry Point

**Current State:**
- ✅ Pipelines expect file paths: `ingestFile(filePath: string, options)`
- ✅ Proxmox documents are generated dynamically (not from files)
- ✅ `vector-document-generator.ts` exists and can generate documents

**Decision:** Use Option A - Write Proxmox documents to temp files, then ingest
- ✅ This approach reuses existing pipeline infrastructure
- ✅ Maintains consistency with other ingestion flows
- ✅ Simplifies implementation for TL-2A.6

---

## ⚠️ Step 4: CLI-Driven Ingestion (Option A)

**Current State:**
- ❌ `scripts/ingest-proxmox.ts` does not exist yet (TO BE CREATED)
- ✅ `package.json` has `pce:*` script pattern
- ✅ Proxmox document generators exist in `src/tools/proxmox/readonly/vector-document-generator.ts`
- ✅ ProxmoxClient has provenance tracking built-in (generateProvenanceId, metadata)

**Action Required:**
1. Create `scripts/ingest-proxmox.ts` (or `src/pce/ingestion/proxmox-ingestion.ts` per TL-2A.6.1)
2. Add `"pce:ingest-proxmox": "bun run scripts/ingest-proxmox.ts"` to package.json
3. Script should:
   - Use ProxmoxClient (via ProxmoxReadOnlyTool) to ensure provenance tracking
   - Query Proxmox cluster for VM inventory, node profiles, cluster status
   - Generate documents using existing generators
   - Write to temp files
   - Call `IngestionPipeline.ingestFile()` for vector store
   - Call `GraphIngestionPipeline.ingestFile()` for graph store
   - Clean up temp files

---

## 📋 Implementation Plan

1. **Create ingestion orchestrator** (`src/pce/ingestion/proxmox-ingestion.ts`) - TL-2A.6.1
   - Use `ProxmoxClient` directly (via ProxmoxReadOnlyTool) to ensure provenance tracking
   - Implement `version_hash` computation helper (SHA-256 of normalized payloads)
   - Use `generateVmInventoryDocument()`, `generateNodeProfileDocument()`, `generateClusterStatusDocument()`
   - Write documents to temp directory
   - Ingest via existing pipelines

2. **Document Type** ✅ VERIFIED
   - ✅ `DocumentType` is defined in `src/pce/types/index.ts`
   - ⚠️ Need to add `"proxmox"` or `"proxmox_inventory"` to the enum

3. **ACL Group**
   - Use `"ops"` or `"admin"` for Proxmox ingestion (read-only data)

4. **Redaction** ✅ VERIFIED
   - ✅ Proxmox redaction patterns exist in `src/pce/redaction/patterns.ts`
   - ✅ Redaction is wired in both pipelines (pipeline.ts ~line 40, graph-pipeline.ts ~line 60)

5. **Graph Ontology** ✅ VERIFIED
   - ✅ `PVE_NODE` and `VM_INSTANCE` already exist in `src/pce/kg/schema/ontology.ts`
   - ⚠️ Requirements mention `ProxmoxNode` and `ProxmoxVM` - may need aliases or use existing labels

---

## 🎯 Implementation Status - IN PROGRESS ⚠️

**Completed foundations:**
1. ✅ Verified `DocumentType` definition location: `src/pce/types/index.ts`
2. ✅ Verified redaction patterns and pipeline wiring
3. ✅ Verified graph ontology labels (PVE_NODE, VM_INSTANCE)
4. ✅ Verified ProxmoxClient provenance tracking
5. ✅ Added `"proxmox_inventory"` to DocumentType enum
6. ✅ Created `src/pce/ingestion/proxmox-ingestion.ts` orchestrator (TL-2A.6.1)
   - Version hash computation helper (SHA-256)
   - ProxmoxClient integration for provenance tracking
   - Document generation and temp file handling
7. ✅ Implemented Vector RAG ingestion (TL-2A.6.A.4, TL-2A.6.A.5)
   - Document structure for VM inventory and node profiles
   - Vector store indexation via IngestionPipeline
8. ✅ Implemented Graph RAG ingestion (TL-2A.6.B.6)
   - Added HOSTS_ON relationship type to ontology
   - Graph node creation (PVE_NODE, VM_INSTANCE)
   - Relationship creation (VM HOSTS_ON Node)
   - ACL and provenance metadata propagation
9. ✅ Added npm script `pce:ingest-proxmox` to `package.json`
10. ✅ Created unit tests (TL-2A.6.7)
    - Version hash computation tests
    - Redaction verification tests
    - Graph node/relationship creation tests
    - ACL and provenance propagation tests
11. ✅ Created end-to-end validation test harness (TL-2A.6.8)
    - `tests/flows/proxmox_tool_less_ingestion.test.ts` exercises the name/structural/resource queries

**Outstanding gaps (Updated 2025-11-18):**
- ⚠️ The **name-based query** ("Where is aiMarketBot?") still fails in practice even after re-ingesting under the `lab-admin` ACL. Hybrid queries return "no context" instead of using the indexed data.
- ⚠️ Vector chunks for the latest ingestion have low similarity scores and do not include the literal `aiMarketBot` string, so the hybrid test cannot pass without improving the generated text.
- ⚠️ Graph retrieval needs validation that the `VM_INSTANCE` node for `aiMarketBot` exists and inherits the `lab-admin` ACL so that HYBRID routing returns structural context.
- ⚠️ Re-run `tests/flows/proxmox_tool_less_ingestion.test.ts` and capture evidence before marking TL-2A.6 complete. The current run is still red because of the missing context and provenance assertions.
- ⚠️ Update the docs/playbooks once the above blockers are cleared (especially the instructions for running the ingestion script with `--acl-group lab-admin`).

**Status:** TL-2A.6 remains **in progress** until the tool-less hybrid queries can pass using only the ingested context (no live Proxmox calls).

