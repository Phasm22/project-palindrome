# Dashboard Options Analysis for Palindrome

## Current State Assessment

### What You Have
- ✅ PCE API with `/query`, `/health`, `/metrics`, `/history/:userId` endpoints
- ✅ Neo4j running (port 7474) with graph data
- ✅ Qdrant running (port 6333) with vector embeddings
- ✅ Tool execution via `tool-executor.ts` (logged but not persisted)
- ✅ Provenance metadata in tool responses
- ✅ Metrics collector in PCE API
- ✅ Context history store (in-memory, limited)

### What's Missing
- ❌ Persistent tool execution audit trail
- ❌ Real-time tool execution streaming
- ❌ Graph visualization UI
- ❌ Vector store introspection UI
- ❌ Agent reasoning visibility
- ❌ Proxmox/OPNsense live status aggregation

---

## Recommended Options (Better Than Your Original 3)

### 🏆 **Option 1: Refine.dev + Custom API Endpoints** (RECOMMENDED)

**Why This Is Better:**
- **TypeScript-native** - Matches your Bun/TS stack perfectly
- **Admin panel framework** - Built for exactly this use case (CRUD + dashboards)
- **Auto-generates UI** from your API schemas
- **Real-time updates** via React Query
- **Graph visualization** via vis.js or Cytoscape.js integration
- **Fast development** - Dashboard in days, not weeks

**What You'd Build:**
```typescript
// New API endpoints to add to PCE API:
GET /api/dashboard/cluster-status      // Aggregated Proxmox status
GET /api/dashboard/tool-executions      // Paginated audit trail
GET /api/dashboard/ontology-graph      // Neo4j graph data (nodes + edges)
GET /api/dashboard/vector-stats         // Qdrant collection stats
GET /api/dashboard/agent-reasoning      // LLM reasoning traces
GET /api/dashboard/rag-diagnostics     // Chunk scores, missing entities
GET /api/dashboard/ssh-health           // SSH connectivity matrix
```

**Tech Stack:**
- Refine.dev (React admin framework)
- TanStack Query (data fetching)
- shadcn/ui (components)
- vis.js or Cytoscape.js (graph visualization)
- Recharts (metrics charts)

**Pros:**
- ✅ Fastest development time
- ✅ Type-safe end-to-end
- ✅ Auto-generates tables/forms from API
- ✅ Built-in auth/ACL support
- ✅ Can embed Neo4j Browser iframe
- ✅ Real-time via WebSockets (easy to add)

**Cons:**
- ⚠️ Requires adding new API endpoints
- ⚠️ React learning curve if team isn't familiar

**Implementation Time:** 2-3 weeks for full dashboard

---

### 🥈 **Option 2: Neo4j Browser + Grafana + Custom Dashboard API**

**Why This Is Better Than Your Option B:**
- **Leverages Neo4j Browser** (already running) for graph exploration
- **Grafana with Neo4j plugin** (not just Prometheus) for time-series
- **Lightweight custom dashboard** for Palindrome-specific views
- **No duplication** - Use existing Neo4j infrastructure

**Architecture:**
```
Neo4j Browser (port 7474) → Graph exploration
Grafana (port 3000) → Time-series metrics + Neo4j plugin
Custom Dashboard API → Palindrome-specific aggregations
```

**What You'd Build:**
1. **Grafana Dashboard:**
   - Neo4j plugin for graph queries
   - Prometheus exporter for PCE metrics (add to your API)
   - Custom panels for tool execution rates
   - Alert rules for drift detection

2. **Custom API Endpoints:**
   - `/api/dashboard/tool-audit` - Tool execution log (needs persistence)
   - `/api/dashboard/cluster-live` - Real-time Proxmox aggregation
   - `/api/dashboard/agent-activity` - Last N agent actions

3. **Simple HTML Dashboard:**
   - Embed Grafana panels
   - Embed Neo4j Browser iframe
   - Custom React/Vue components for Palindrome-specific views

**Pros:**
- ✅ Reuses existing Neo4j Browser
- ✅ Grafana is battle-tested for ops
- ✅ Time-series built-in
- ✅ Alerting built-in
- ✅ Can query Neo4j directly from Grafana

**Cons:**
- ⚠️ Grafana learning curve
- ⚠️ Need to add Prometheus exporter
- ⚠️ Multiple tools to maintain

**Implementation Time:** 3-4 weeks

---

### 🥉 **Option 3: Metabase + Neo4j Connection**

**Why This Is Better:**
- **Direct Neo4j connection** - No custom API needed for graph queries
- **BI-style dashboards** - Perfect for "what does the agent think" views
- **Self-hosted** - Matches your homelab philosophy
- **SQL-like queries** - Easier than Cypher for non-graph questions

**What You'd Build:**
1. **Metabase Setup:**
   - Connect to Neo4j (via JDBC or Cypher queries)
   - Create dashboards for:
     - Ontology graph (via Cypher)
     - Workload inventory
     - Tool execution trends
     - RAG chunk statistics

2. **Custom API Endpoints:**
   - Still need `/api/dashboard/tool-executions` (persistent audit trail)
   - `/api/dashboard/cluster-live` (Proxmox aggregation)

3. **Embed Metabase:**
   - Iframe or embed in custom React app
   - Or use Metabase as standalone

**Pros:**
- ✅ No-code dashboard building
- ✅ Direct Neo4j queries
- ✅ Great for ad-hoc analysis
- ✅ Self-hosted
- ✅ User-friendly for non-devs

**Cons:**
- ⚠️ Metabase is heavy (Java-based)
- ⚠️ Less real-time than custom solution
- ⚠️ Graph visualization is limited

**Implementation Time:** 2-3 weeks

---

### **Option 4: Remix + HTMX (Server-Rendered)**

**Why This Is Different:**
- **Minimal JavaScript** - Fast, simple, old-school but effective
- **Server-rendered** - SEO-friendly, works without JS
- **Real-time via HTMX** - WebSocket-like updates without complexity
- **Perfect for ops dashboards** - No over-engineering

**What You'd Build:**
```typescript
// Remix routes:
/dashboard/cluster          // Server-rendered Proxmox status
/dashboard/tools            // Tool execution log
/dashboard/graph            // Neo4j graph (via API)
/dashboard/rag              // Vector store stats
```

**Pros:**
- ✅ Fastest page loads
- ✅ Minimal complexity
- ✅ Works on any device
- ✅ Easy to add real-time updates
- ✅ TypeScript-native

**Cons:**
- ⚠️ Less interactive than React
- ⚠️ Graph visualization needs custom work
- ⚠️ Team might prefer React

**Implementation Time:** 2-3 weeks

---

### **Option 5: Panel/Holoviz (Python-Based)**

**Why Consider This:**
- **Python ecosystem** - Great for data science/ops dashboards
- **Interactive visualizations** - Bokeh, Plotly built-in
- **Can query Neo4j** via Python driver
- **Containerized** - Runs alongside your Bun services

**Pros:**
- ✅ Excellent for data visualization
- ✅ Python ecosystem (pandas, numpy)
- ✅ Interactive graphs out of the box

**Cons:**
- ⚠️ Python stack (different from your TS codebase)
- ⚠️ Another language to maintain
- ⚠️ Less integrated with your API

**Implementation Time:** 3-4 weeks

---

## Critical Prerequisites (All Options Need These)

### 1. **Persistent Tool Execution Audit Trail**

**Current State:** Tool executions are logged but not persisted.

**What You Need:**
```typescript
// Add to src/pce/api/server.ts or new file:
export class ToolExecutionStore {
  async recordExecution(
    toolName: string,
    parameters: Record<string, any>,
    result: ExecutionResult,
    userId: string,
    aclGroup: ACLGroup,
    durationMs: number
  ): Promise<void> {
    // Store in SQLite, PostgreSQL, or Neo4j
  }
  
  async getExecutions(
    filters: { toolName?: string; userId?: string; since?: Date },
    limit: number = 100
  ): Promise<ToolExecution[]> {
    // Query stored executions
  }
}
```

**Storage Options:**
- **SQLite** - Simplest, file-based
- **PostgreSQL** - If you want proper DB
- **Neo4j** - Store as nodes with relationships to VMs/tools
- **File-based JSON** - Quick hack, not recommended for production

### 2. **Real-Time Tool Execution Streaming**

**Add WebSocket endpoint:**
```typescript
// In PceApiServer:
if (url.pathname === "/ws/tool-executions") {
  return this.handleToolExecutionWebSocket(req, server);
}
```

### 3. **Graph Data API Endpoint**

**Expose Neo4j queries:**
```typescript
GET /api/dashboard/graph
  ?query=MATCH (n:VM_INSTANCE)-[r]->(m) RETURN n, r, m
  &limit=100
```

### 4. **Vector Store Introspection**

**Add Qdrant stats endpoint:**
```typescript
GET /api/dashboard/vector-stats
// Returns: collection size, chunk counts, last ingestion, etc.
```

---

## My Recommendation: **Refine.dev + Custom API** (Option 1)

### Why:
1. **Fastest to build** - Admin panel framework does heavy lifting
2. **TypeScript-native** - Matches your stack
3. **Real-time ready** - React Query + WebSockets
4. **Graph visualization** - Easy to add vis.js
5. **Future-proof** - Can add CRUD operations later (e.g., manage ACLs)

### Implementation Plan:

**Week 1: Foundation**
1. Add persistent tool execution store (SQLite or Neo4j)
2. Add new API endpoints:
   - `/api/dashboard/tool-executions`
   - `/api/dashboard/cluster-status`
   - `/api/dashboard/ontology-graph`
   - `/api/dashboard/vector-stats`
3. Add WebSocket endpoint for real-time updates

**Week 2: Refine.dev Setup**
1. Initialize Refine.dev project in `/dashboard`
2. Configure API client to point to PCE API
3. Create resource definitions for:
   - Tool executions
   - Cluster status
   - Ontology graph
   - Vector stats

**Week 3: Dashboard Components**
1. Tool execution log table (with filters)
2. Cluster status panel (Proxmox nodes)
3. Graph visualization (vis.js integration)
4. RAG diagnostics panel
5. Agent activity timeline

**Week 4: Polish & Real-Time**
1. Add WebSocket subscriptions
2. Add alerting/notifications
3. Add export functionality
4. Add ACL-based filtering

---

## Alternative: **Hybrid Approach** (Best of Both Worlds)

**Use Neo4j Browser + Grafana + Lightweight Custom Dashboard:**

1. **Neo4j Browser** (port 7474) - For graph exploration (no code needed)
2. **Grafana** - For time-series metrics (add Prometheus exporter to PCE API)
3. **Simple React Dashboard** - For Palindrome-specific views:
   - Tool execution audit trail
   - Agent reasoning traces
   - RAG diagnostics
   - Cluster live status

**This gives you:**
- ✅ Graph exploration (Neo4j Browser)
- ✅ Time-series metrics (Grafana)
- ✅ Custom Palindrome views (React dashboard)
- ✅ Less code to maintain than full Refine.dev setup

---

## Comparison Matrix

| Feature | Refine.dev | Grafana+Neo4j | Metabase | Remix+HTMX | Panel |
|---------|-----------|----------------|----------|------------|-------|
| Development Speed | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| TypeScript Native | ✅ | ⚠️ | ❌ | ✅ | ❌ |
| Graph Visualization | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ |
| Real-Time Updates | ✅ | ✅ | ⚠️ | ✅ | ⚠️ |
| Time-Series | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ |
| Self-Hosted | ✅ | ✅ | ✅ | ✅ | ✅ |
| Learning Curve | Medium | High | Low | Low | Medium |
| Maintenance | Low | Medium | Medium | Low | Medium |

---

## Next Steps

1. **Decide on approach** (I recommend Refine.dev or Hybrid)
2. **Add persistent tool execution store** (critical for all options)
3. **Add new API endpoints** (needed for dashboard)
4. **Choose graph visualization library** (vis.js, Cytoscape.js, or D3.js)
5. **Start with MVP** - Build one panel at a time

---

## Questions to Consider

1. **Who will use the dashboard?** (Devs only? Ops team? Non-technical?)
2. **How real-time does it need to be?** (WebSockets vs polling)
3. **Do you need write operations from the dashboard?** (Refine.dev excels here)
4. **Graph visualization priority?** (Neo4j Browser might be enough)
5. **Time-series priority?** (Grafana excels here)

---

## My Final Recommendation

**Start with Hybrid Approach:**
1. Use **Neo4j Browser** for graph exploration (it's already running!)
2. Add **Grafana** for time-series metrics (add Prometheus exporter)
3. Build **lightweight React dashboard** for Palindrome-specific views

**Then evolve to Refine.dev** if you need:
- CRUD operations (manage ACLs, tools, etc.)
- More complex admin features
- User management
- Audit trails with filtering/search

This gives you **immediate value** (Neo4j Browser + Grafana) while building the custom dashboard incrementally.

