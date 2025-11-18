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

## ⚠️ Step 3: Proxmox Document Entry Point

**Current State:**
- Pipelines expect file paths: `ingestFile(filePath: string, options)`
- Proxmox documents are generated dynamically (not from files)
- `vector-document-generator.ts` exists and can generate documents

**Decision Required:**
- **Option A (Recommended):** Write Proxmox documents to temp files, then ingest
- **Option B:** Add `ingestContent(content: string, ...)` method to pipelines

**Recommendation:** Use Option A for TL-2A.6 (simpler, reuses existing pipeline)

---

## ✅ Step 4: CLI-Driven Ingestion (Option A)

**Current State:**
- ❌ `scripts/ingest-proxmox.ts` does not exist yet
- ✅ `package.json` has `pce:*` script pattern
- ✅ Proxmox document generators exist in `src/tools/proxmox/readonly/vector-document-generator.ts`

**Action Required:**
1. Create `scripts/ingest-proxmox.ts`
2. Add `"pce:ingest-proxmox": "bun run scripts/ingest-proxmox.ts"` to package.json
3. Script should:
   - Query Proxmox cluster for VM inventory, node profiles, cluster status
   - Generate documents using existing generators
   - Write to temp files
   - Call `IngestionPipeline.ingestFile()` for vector store
   - Call `GraphIngestionPipeline.ingestFile()` for graph store
   - Clean up temp files

---

## 📋 Implementation Plan

1. **Create ingestion script** (`scripts/ingest-proxmox.ts`)
   - Use `ProxmoxReadOnlyTool` to fetch data
   - Use `generateVmInventoryDocument()`, `generateNodeProfileDocument()`, `generateClusterStatusDocument()`
   - Write documents to temp directory
   - Ingest via existing pipelines

2. **Document Type**
   - Need to check/define `DocumentType` enum - likely need to add `"proxmox"` or similar

3. **ACL Group**
   - Use `"ops"` or `"admin"` for Proxmox ingestion (read-only data)

4. **Redaction**
   - Ensure Proxmox redaction patterns are applied (already in `src/pce/redaction/patterns.ts`)

---

## 🎯 Next Steps

1. Check `DocumentType` definition location
2. Create `scripts/ingest-proxmox.ts`
3. Add npm script to `package.json`
4. Test ingestion end-to-end

