# Phase I-B (Structural MVP) Audit Report
**Date:** 2024-11-17  
**Repository State:** Current codebase inspection

---

## A. REQUIREMENT-BY-REQUIREMENT INSPECTION

### 1. Ontology Definition

**Status:** **Partially Implemented**

**What Exists:**
- **File:** `src/pce/kg/schema/ontology.ts`
- **NodeType enum** includes: `HOST`, `SERVICE`, `VLAN`, `ALERT`, `USER`, `NETWORK`, `FIREWALL_RULE`, `CONFIG`
- **Proxmox extensions:** `PVE_NODE`, `VM_INSTANCE`, `PVE_STORAGE`
- **Standard fields:** `id`, `type`, `attributes`, `aliases`, `versionHash`, `sourcePath`, `aclGroup`, `createdAt`, `updatedAt`
- **EntityAttributes interface** defines required attributes per type
- **Validation function:** `validateNodeAttributes()` enforces schema

**What's Missing:**
- ❌ **Container** type (required: Host, VM, Container, VLAN, Service, User, Dependency, Network)
- ❌ **Dependency** type (required: Host, VM, Container, VLAN, Service, User, Dependency, Network)
- ❌ **canonical_id** field (spec requires: `id, name, canonical_id, type`)
  - Current: `id` exists but is used as canonical ID
  - Missing: explicit `canonical_id` field separate from `id`
- ❌ **name** field standardization (spec requires: `id, name, canonical_id, type`)
  - Current: `name` is embedded in `attributes` (e.g., `attributes.hostname`, `attributes.name`)
  - Missing: top-level `name` field on all entities

**Implementation Location:**
```12:45:src/pce/kg/schema/ontology.ts
export enum NodeType {
  HOST = "Host",
  SERVICE = "Service",
  VLAN = "VLAN",
  ALERT = "Alert",
  USER = "User",
  NETWORK = "Network",
  FIREWALL_RULE = "FirewallRule",
  CONFIG = "Config",
  // Proxmox-specific node types (TL-2A.6.B)
  PVE_NODE = "PVE_NODE",
  VM_INSTANCE = "VM_INSTANCE",
  PVE_STORAGE = "PVE_STORAGE",
}
```

---

### 2. Relationship Ingestion

**Status:** **Partially Implemented**

**What Exists:**
- **File:** `src/pce/kg/schema/ontology.ts`
- **RelationshipType enum** includes:
  - ✅ `CONNECTS_TO`
  - ✅ `RUNS_ON`
  - ✅ `AFFECTS`
  - ✅ `BELONGS_TO` (VLAN membership)
  - ✅ `HOSTS_ON` (Proxmox-specific, but semantically similar to HOSTS)
- **Additional relationships:** `CONFIGURED_BY`, `OWNS`, `LOGGED_BY`, `TRIGGERS`, `ACCESSES`, `USES`, `CONNECTED_TO`
- **Relationship structure:** `from`, `to`, `type`, `properties`, `versionHash`, `sourcePath`, `aclGroup`, `createdAt`

**What's Missing:**
- ❌ **DEPENDS_ON** relationship (required: CONNECTS_TO, RUNS_ON, DEPENDS_ON, AFFECTS, HOSTS, BELONGS_TO)
- ❌ **HOSTS** relationship (required: CONNECTS_TO, RUNS_ON, DEPENDS_ON, AFFECTS, HOSTS, BELONGS_TO)
  - Note: `HOSTS_ON` exists but is reversed (VM HOSTS_ON Node vs Node HOSTS VM)
  - Spec likely expects: `HOSTS` (Node HOSTS VM)

**Implementation Location:**
```47:60:src/pce/kg/schema/ontology.ts
export enum RelationshipType {
  CONNECTS_TO = "CONNECTS_TO",
  AFFECTS = "AFFECTS",
  CONFIGURED_BY = "CONFIGURED_BY",
  OWNS = "OWNS",
  LOGGED_BY = "LOGGED_BY",
  RUNS_ON = "RUNS_ON",
  BELONGS_TO = "BELONGS_TO",
  TRIGGERS = "TRIGGERS",
  ACCESSES = "ACCESSES",
  // Proxmox-specific relationship types (TL-2A.6.B)
  USES = "USES", // VM USES Storage
  CONNECTED_TO = "CONNECTED_TO", // Storage CONNECTED_TO Node
  HOSTS_ON = "HOSTS_ON", // VM HOSTS_ON Node (VM is hosted on Node)
}
```

---

### 3. Normalization

**Status:** **Fully Implemented**

**What Exists:**
- **File:** `src/pce/edl/normalization/normalizer.ts`
- **Canonical ID generation:** `generateCanonicalId(normalizedText, type)` → `type:normalized-text`
- **Text normalization:** `normalizeEntityText()` - lowercase, remove domain suffixes, standardize delimiters
- **File:** `src/pce/edl/normalization/alias-mapper.ts`
- **Alias mapping:** Levenshtein distance calculation with similarity threshold (0.85)
- **Ambiguity tracking:** Logs ambiguous matches (0.70-0.85 similarity range)
- **Duplicate consolidation:** 
  - Node upsert via `MERGE` in Neo4j (`src/pce/kg/indexation/neo4j-client.ts:writeNode()`)
  - Relationship duplicate detection (`src/pce/kg/indexation/neo4j-client.ts:writeRelationship()`)
  - Alias resolution in EDL pipeline (`src/pce/edl/pipeline.ts`)

**Implementation Locations:**
```1:50:src/pce/edl/normalization/normalizer.ts
export function normalizeEntityText(text: string): string {
  let normalized = text.trim();
  normalized = normalized.toLowerCase();
  normalized = normalized.replace(/\.(local|lan|internal|example\.com)$/i, "");
  normalized = normalized.replace(/[_\s]+/g, "-");
  normalized = normalized.replace(/-+/g, "-");
  // ... more normalization
  return normalized;
}

export function generateCanonicalId(normalizedText: string, type: string): string {
  return `${type.toLowerCase()}:${normalizedText}`;
}
```

```1:100:src/pce/edl/normalization/alias-mapper.ts
function levenshteinDistance(str1: string, str2: string): number {
  // ... Levenshtein implementation
}

export class AliasMapper {
  findAlias(candidateText: string, candidateType: string): AliasMatch | null {
    // ... similarity matching with 0.85 threshold
  }
}
```

---

### 4. Entity Extraction

**Status:** **Partially Implemented**

**What Exists:**
- **Proxmox ingestion:** ✅ Fully implemented
  - **File:** `src/tools/proxmox/readonly/graph-entity-extractor.ts`
  - **Function:** `extractProxmoxGraphEntities()` extracts PVE_NODE, VM_INSTANCE, PVE_STORAGE
  - **Relationships:** RUNS_ON, CONNECTS_TO, CONNECTED_TO, HOSTS_ON
  - **File:** `src/pce/ingestion/proxmox-ingestion.ts`
  - **Orchestrator:** `ProxmoxIngestionOrchestrator` coordinates ingestion
- **LLM-based extraction:** ✅ Implemented
  - **File:** `src/pce/edl/extraction/extractor.ts`
  - **Class:** `EntityExtractor` uses GPT-4o-mini to extract entities/relationships from text
  - **Supports:** All NodeType and RelationshipType enums
- **EDL Pipeline:** ✅ Implemented
  - **File:** `src/pce/edl/pipeline.ts`
  - **Class:** `EDLPipeline` orchestrates extraction → validation → normalization → alias mapping

**What's Missing:**
- ❌ **Topology.yaml ingestion:** Not implemented
  - **File exists:** `docs/topology.yaml` (contains networks, hosts, VLANs)
  - **No ingestion code:** No parser/extractor for YAML topology files
  - **DocumentType exists:** `yaml_config` in `src/pce/types/index.ts` but no specialized handler
- ❌ **Runbook ingestion:** Partially implemented
  - **DocumentType exists:** `markdown_runbook` in `src/pce/types/index.ts`
  - **Chunking exists:** `src/pce/redaction/chunker.ts` handles markdown_runbook
  - **No specialized extraction:** Uses generic LLM extraction, no runbook-specific entity extraction
- ❌ **Normalized JSON output:** Current extraction produces GraphNode/GraphRelationship objects, but spec requires "normalized JSON entities with types + relationships"
  - Current: TypeScript interfaces
  - Missing: Explicit JSON schema/validation for normalized entity format

**Implementation Locations:**
```1:200:src/tools/proxmox/readonly/graph-entity-extractor.ts
export async function extractProxmoxGraphEntities(
  aclGroup: ACLGroup = "viewer",
  versionHash?: string,
  sourcePath?: string
): Promise<ProxmoxGraphEntities> {
  // ... extracts nodes and relationships from Proxmox API
}
```

```1:100:src/pce/edl/extraction/extractor.ts
export class EntityExtractor {
  async extract(chunkText: string): Promise<ExtractionResult> {
    // ... LLM-based extraction
  }
}
```

---

### 5. Graph Storage Layer

**Status:** **Fully Implemented**

**What Exists:**
- **Graph client wrapper:** ✅ `Neo4jGraphStore` class
  - **File:** `src/pce/kg/indexation/neo4j-client.ts`
  - **Methods:** `connect()`, `close()`, `getDriver()`, `healthCheck()`
- **Upsert logic for nodes:** ✅ Implemented
  - **Method:** `writeNode()` uses `MERGE` with `ON CREATE` / `ON MATCH`
  - **Batch support:** `writeNodes()` with transaction
- **Upsert logic for edges:** ✅ Implemented
  - **Method:** `writeRelationship()` with duplicate detection
  - **Batch support:** `writeRelationships()` with transaction
  - **Cycle prevention:** Self-loop detection
- **Version hash linking:** ✅ Implemented
  - **Field:** `versionHash` on both nodes and relationships
  - **Provenance:** `sourcePath` field tracks source document
- **ACL group propagation:** ✅ Implemented
  - **Field:** `aclGroup` on both nodes and relationships
  - **Enforcement:** ACL filtering in `GraphRAGRetrieval.enforceAclGuards()`
- **Indexes:** ✅ Created for `id`, `type`, `versionHash`
- **Schema versioning:** ✅ `getSchemaVersion()`, `setSchemaVersion()`

**Implementation Locations:**
```1:200:src/pce/kg/indexation/neo4j-client.ts
export class Neo4jGraphStore {
  async writeNode(node: GraphNode): Promise<void> {
    // MERGE with ON CREATE / ON MATCH
  }
  
  async writeRelationship(rel: GraphRelationship): Promise<void> {
    // Duplicate detection + cycle prevention
  }
}
```

---

### 6. Graph Retrieval Interface

**Status:** **Partially Implemented**

**What Exists:**
- **Query by id/name/type:** ✅ Implemented
  - **File:** `src/pce/kg/queries/query-interface.ts`
  - **Methods:** 
    - `findEntitiesByIdOrName(searchTerm)` - case-insensitive partial match
    - `getEntitiesByType(type)` - filter by type
    - `executeQuery(cypher, parameters)` - custom Cypher queries
- **Structural RAG retrieval path:** ✅ Implemented
  - **File:** `src/pce/graph-retrieval/graph-rag.ts`
  - **Class:** `GraphRAGRetrieval`
  - **Method:** `retrieve(query, queryType, aclGroup)` - supports "alerts", "connections", "path", "entities"
- **Hybrid retrieval support:** ✅ Implemented
  - **File:** `src/pce/rag/hybrid-orchestrator.ts`
  - **Class:** `HybridOrchestrator` coordinates vector + graph retrieval
  - **File:** `src/pce/rag/fusion.ts`
  - **Class:** `FusionEngine` combines vector and graph results
- **Provenance scoring:** ✅ Implemented
  - **Field:** `versionHash` and `sourcePath` returned in results
  - **Method:** `getEntitiesWithProvenance(entityIds)` retrieves provenance metadata

**What's Missing:**
- ❌ **Recency scoring:** Not implemented
  - **Spec requires:** "Recency + provenance scoring"
  - **Current:** Provenance exists, but no recency calculation (e.g., based on `createdAt`/`updatedAt` timestamps)
  - **Fusion engine:** Has `recency` weight (0.1) in `DEFAULT_FUSION_WEIGHTS` but no actual recency calculation
- ⚠️ **Query interface completeness:** Some query methods exist but may need expansion
  - `findAlertsAffectingHost(hostId)` - exists
  - `findHostsConnectedToService(serviceId)` - exists
  - `findPath(fromId, toId)` - exists
  - Missing: Generic relationship traversal queries

**Implementation Locations:**
```1:200:src/pce/kg/queries/query-interface.ts
export class GraphQueryInterface {
  async findEntitiesByIdOrName(searchTerm: string): Promise<GraphQueryResult> {
    // ... Cypher query with pattern matching
  }
  
  async getEntitiesByType(type: string): Promise<GraphQueryResult> {
    // ... filter by type
  }
}
```

```1:100:src/pce/graph-retrieval/graph-rag.ts
export class GraphRAGRetrieval {
  async retrieve(
    query: string,
    queryType: "alerts" | "connections" | "path" | "entities" = "entities",
    aclGroup?: ACLGroup
  ): Promise<GraphRetrievalResult> {
    // ... structural retrieval
  }
}
```

---

## B. DIFF LIST: Expected Spec vs Actual Codebase

### Requirement 1: Ontology Definition

| Expected | Actual | Status |
|----------|--------|--------|
| Canonical types: Host, VM, Container, VLAN, Service, User, Dependency, Network | Host, Service, VLAN, Alert, User, Network, FirewallRule, Config, PVE_NODE, VM_INSTANCE, PVE_STORAGE | ❌ Missing: Container, Dependency |
| Standard fields: id, name, canonical_id, type | id, type, attributes (name embedded), aliases, versionHash, sourcePath, aclGroup, createdAt, updatedAt | ❌ Missing: explicit `name`, `canonical_id` fields |

### Requirement 2: Relationship Ingestion

| Expected | Actual | Status |
|----------|--------|--------|
| CONNECTS_TO | CONNECTS_TO | ✅ |
| RUNS_ON | RUNS_ON | ✅ |
| DEPENDS_ON | (missing) | ❌ |
| AFFECTS | AFFECTS | ✅ |
| HOSTS | HOSTS_ON (reversed direction) | ⚠️ Direction mismatch |
| BELONGS_TO | BELONGS_TO | ✅ |

### Requirement 3: Normalization

| Expected | Actual | Status |
|----------|--------|--------|
| Canonical ID generation | `generateCanonicalId()` → `type:normalized-text` | ✅ |
| Duplicate consolidation | MERGE in Neo4j + alias mapper | ✅ |
| Alias mapping (Levenshtein) | `AliasMapper` with Levenshtein distance | ✅ |

### Requirement 4: Entity Extraction

| Expected | Actual | Status |
|----------|--------|--------|
| From Proxmox ingestion | `extractProxmoxGraphEntities()` | ✅ |
| From topology.yaml | (missing) | ❌ |
| From runbooks | Generic LLM extraction only | ⚠️ No specialized handler |
| From other structured sources | Generic LLM extraction | ⚠️ |
| Normalized JSON entities | TypeScript interfaces (GraphNode/GraphRelationship) | ⚠️ Not explicit JSON schema |

### Requirement 5: Graph Storage Layer

| Expected | Actual | Status |
|----------|--------|--------|
| Graph client wrapper for Neo4j | `Neo4jGraphStore` | ✅ |
| Upsert logic for nodes | `writeNode()` with MERGE | ✅ |
| Upsert logic for edges | `writeRelationship()` with duplicate detection | ✅ |
| Version hash linking | `versionHash` field | ✅ |
| ACL group propagation | `aclGroup` field + enforcement | ✅ |

### Requirement 6: Graph Retrieval Interface

| Expected | Actual | Status |
|----------|--------|--------|
| Query by id/name/type | `findEntitiesByIdOrName()`, `getEntitiesByType()` | ✅ |
| Structural RAG retrieval path | `GraphRAGRetrieval.retrieve()` | ✅ |
| Hybrid retrieval support | `HybridOrchestrator` + `FusionEngine` | ✅ |
| Recency + provenance scoring | Provenance ✅, Recency ❌ | ⚠️ Recency missing |

---

## C. FIRST ACTIONABLE TASKS

### Task 1: Add Missing Ontology Types
**File:** `src/pce/kg/schema/ontology.ts`  
**Action:** Add `Container` and `Dependency` to `NodeType` enum. Add corresponding `EntityAttributes` entries with required fields (Container: `name`, `type`, `host`; Dependency: `name`, `depends_on`, `type`).

### Task 2: Add Standard Fields (name, canonical_id)
**File:** `src/pce/kg/schema/ontology.ts`  
**Action:** Modify `GraphNode` interface to include top-level `name: string` and `canonical_id: string` fields. Update `generateCanonicalId()` to populate `canonical_id`, and extract `name` from attributes during normalization.

### Task 3: Add DEPENDS_ON Relationship
**File:** `src/pce/kg/schema/ontology.ts`  
**Action:** Add `DEPENDS_ON = "DEPENDS_ON"` to `RelationshipType` enum.

### Task 4: Add HOSTS Relationship (or clarify direction)
**File:** `src/pce/kg/schema/ontology.ts`  
**Action:** Either add `HOSTS = "HOSTS"` relationship type, or document that `HOSTS_ON` is the reverse direction and add bidirectional support. Update Proxmox extractor to use correct direction.

### Task 5: Implement Topology.yaml Ingestion
**File:** Create `src/pce/ingestion/topology-ingestion.ts`  
**Action:** Create `TopologyIngestionOrchestrator` class that parses `docs/topology.yaml`, extracts Host, Network, VLAN entities, and creates CONNECTS_TO, BELONGS_TO relationships. Integrate with `GraphIngestionPipeline`.

### Task 6: Implement Runbook-Specific Entity Extraction
**File:** `src/pce/edl/extraction/extractor.ts` or create `src/pce/edl/extraction/runbook-extractor.ts`  
**Action:** Create specialized extractor for markdown runbooks that identifies Host, Service, Dependency entities from runbook structure (headers, code blocks, configuration sections).

### Task 7: Implement Recency Scoring
**File:** `src/pce/rag/fusion.ts`  
**Action:** Add `calculateRecencyScore(entity: GraphNode | GraphRelationship): number` method that computes recency based on `createdAt`/`updatedAt` timestamps (e.g., exponential decay). Integrate into `calculateFusionScores()` method.

### Task 8: Add Normalized JSON Schema
**File:** Create `src/pce/kg/schema/normalized-entity-schema.ts`  
**Action:** Define JSON schema for normalized entity format (with `id`, `name`, `canonical_id`, `type`, `attributes`, `relationships`). Add validation function to ensure extraction output matches schema.

---

## D. INCREMENTAL COMPLETION ASSESSMENT

**Can Phase I-B be completed incrementally?** **YES, with minor refactoring**

### Refactoring Required:
1. **GraphNode interface change** (Task 2) - Adding `name` and `canonical_id` fields will require:
   - Updating all node creation sites (Proxmox extractor, EDL pipeline, etc.)
   - Migration script for existing Neo4j nodes (or handle missing fields gracefully)
   - **Impact:** Medium - touches multiple files but is additive

2. **Relationship direction clarification** (Task 4) - If adding `HOSTS` relationship:
   - May need to update Proxmox extractor to use `HOSTS` instead of `HOSTS_ON`
   - Or add both directions for compatibility
   - **Impact:** Low - isolated to Proxmox ingestion

### No Major Refactoring Required:
- Adding new NodeType/RelationshipType enums is additive
- Topology.yaml and runbook ingestion are new features (no breaking changes)
- Recency scoring is additive to fusion engine
- Normalized JSON schema is validation-only (doesn't break existing code)

### Recommended Approach:
1. **Phase 1 (Low Risk):** Add missing types/relationships (Tasks 1, 3, 4)
2. **Phase 2 (Medium Risk):** Add standard fields with backward compatibility (Task 2)
3. **Phase 3 (New Features):** Implement topology/runbook ingestion (Tasks 5, 6)
4. **Phase 4 (Enhancement):** Add recency scoring and JSON schema (Tasks 7, 8)

**Conclusion:** Phase I-B can be completed incrementally. The main refactoring (adding `name` and `canonical_id` fields) is manageable and can be done with backward compatibility in mind.

---

## SUMMARY

| Requirement | Status | Completion % |
|-------------|--------|--------------|
| 1. Ontology Definition | Partially Implemented | 70% |
| 2. Relationship Ingestion | Partially Implemented | 80% |
| 3. Normalization | Fully Implemented | 100% |
| 4. Entity Extraction | Partially Implemented | 60% |
| 5. Graph Storage Layer | Fully Implemented | 100% |
| 6. Graph Retrieval Interface | Partially Implemented | 85% |

**Overall Phase I-B Completion: ~82%**

**Critical Gaps:**
- Missing Container and Dependency node types
- Missing explicit `name` and `canonical_id` fields
- Missing DEPENDS_ON relationship
- Missing topology.yaml ingestion
- Missing recency scoring

