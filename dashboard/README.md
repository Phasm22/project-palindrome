# Palindrome Dashboard

A lightweight dashboard for monitoring Palindrome agent activity, tool executions, and system health.

## Quick Start

1. **Start the Palindrome API server:**
   ```bash
   bun run pce:api
   ```

2. **Open the dashboard:**
   - Option 1: Open `dashboard/index.html` directly in your browser
   - Option 2: Serve it with a simple HTTP server:
     ```bash
     cd dashboard
     python3 -m http.server 8080
     # Then open http://localhost:8080
     ```

3. **Configure API URL (if needed):**
   - The dashboard defaults to `http://localhost:4000`
   - To change it, edit the `API_URL` variable in `index.html` or set environment variable `VITE_PALINDROME_API_URL`

## Features

### Query Tab
The Query tab provides an interactive interface for querying both RAG and graph data. See [QUERY_TAB_GUIDE.md](./QUERY_TAB_GUIDE.md) for detailed usage instructions.

**Quick Start:**
- **Natural Language (RAG):** Ask questions in plain English
- **Graph Query:** Use preset queries to explore the knowledge graph
- **Cypher Query:** Write custom Neo4j Cypher queries

### Overview Tab
- **Execution Statistics**: Total executions, error rate, average duration
- **Cluster Status**: Proxmox cluster health (when implemented)
- **System Health**: Palindrome API, Neo4j, Qdrant health checks

### Tool Executions Tab
- Real-time view of all tool executions
- Filter by tool name, user, ACL group
- See parameters, results, and execution times
- Identify failed executions

### Ontology Graph Tab
- Visualize the knowledge graph stored in Neo4j
- Interactive graph with zoom and pan
- See relationships between VMs, nodes, and entities

### RAG Diagnostics Tab
- Test RAG queries and see:
  - Query type (semantic, graph, hybrid)
  - Total score
  - Top matching chunks
  - Source paths and scores
  - Full diagnostic information

## API Endpoints Used

The dashboard calls these endpoints from the Palindrome API:

- `GET /api/dashboard/execution-stats` - Execution statistics
- `GET /api/dashboard/tool-executions` - Tool execution log
- `GET /api/dashboard/cluster-status` - Proxmox cluster status
- `GET /api/dashboard/ontology-graph` - Neo4j graph data
- `GET /api/dashboard/rag-diagnostics?query=...` - RAG query diagnostics
- `POST /api/dashboard/query/rag` - Execute RAG query
- `POST /api/dashboard/query/graph` - Execute graph query
- `POST /api/dashboard/query/cypher` - Execute Cypher query
- `GET /health` - System health check

## Next Steps

### Enhanced Dashboard (Future)
- Add Grafana integration for time-series metrics
- Add WebSocket support for real-time updates
- Add filtering and search capabilities
- Add export functionality
- Add ACL-based filtering

### Grafana Setup
See `docs/technical/dashboard-implementation-plan.md` for Grafana configuration.

### Neo4j Browser
Access Neo4j Browser directly at `http://localhost:7474` for advanced graph queries.

