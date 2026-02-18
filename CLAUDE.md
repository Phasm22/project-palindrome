# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime & Tooling

- **Bun** is the runtime and package manager (not Node.js/npm). Use `bun` for all commands.
- TypeScript files are executed directly via Bun — no separate compile step.
- Tests use **Vitest** but are run through Bun: `bun test`
- To run a single test file: `bun test tests/reasoning/some-test.ts`

## Key Commands

```bash
bun install                   # Install dependencies
bun test                      # Run all tests
bun run dev                   # Run agent CLI (interactive)
bun run agent "query"         # Run agent with a specific query
bun run pce:api               # Start PCE API server (port 4000)
bun run dashboard:serve       # Serve web dashboard

# Ingestion (populates Neo4j + Qdrant from live infrastructure)
bun run pce:ingest-all
bun run pce:ingest-proxmox
bun run pce:ingest-network
bun run pce:ingest-firewall

# Services (Docker)
bun run services:start        # docker compose up -d
bun run services:stop
bun run services:status       # docker compose ps
```

## Architecture Overview

Palindrome is a **local-first infrastructure assistant** with a digital twin of your network. It combines natural language understanding with autonomous infrastructure operations.

### Data Flow

```
User Query
  → Intent Classifier (compute / network / firewall / exposure)
  → Hybrid RAG (Neo4j graph + Qdrant vector semantic search)
  → Agent (OpenAI GPT-4o) + Tool Selection
  → Tool Execution (with ACL/risk checks)
  → Response Formatter
```

### Core Subsystems

**Agent** (`src/agent/`)
- `runner.ts` — main LLM loop; loads tools, handles tool calls, streams events
- `tool-loader.ts` — registers the ~13 available tools into agent context
- `tool-policy.ts` — ACL groups (viewer/admin/full) and risk stratification; high-risk ops require confirmation
- `system-prompt.ts` — agent constitutional principles
- `event-bus.ts` — SSE event streaming for real-time feedback

**Intent & Reasoning** (`src/reasoning/`)
- `intent-classifier.ts` — routes queries to domain chains
- `chains/` — specialized query logic for compute, network, firewall, exposure
- `compute-intents.ts`, `detectNetworkIntent.ts`, `detectFirewallIntent.ts` — domain classifiers

**PCE System** (`src/pce/`) — Prompts, Context, Evidence
- `api/server.ts` — HTTP server (port 4000): `/api/query`, `/api/agent`, `/api/agent/stream`, `/api/chat`
- `rag/` — Hybrid orchestrator merging Neo4j + Qdrant results
- `kg/` — Knowledge graph indexing (Neo4j)
- `vector/` — Vector store operations (Qdrant)
- `redaction/` — Strips sensitive data from responses

**Tools** (`src/tools/`)
- `proxmox/readonly/` — Read VMs, nodes, cluster state
- `proxmox/writes/` — VM lifecycle operations
- `opnsense/readonly/` and `opnsense/writes/` — Firewall rules, DNS
- `SSHTool.ts` — OS-level commands on VMs
- `TwinQueryTool.ts` — Query the digital twin (prefer this over live proxmox reads)
- `ActionTool.ts` — Automation layer for infrastructure changes

**Digital Twin** (`src/twin/`)
- Maintains a Neo4j model of all infrastructure entities
- `twin-query-service.ts` — query interface for the twin
- **Always prefer `twin_query` tool over live API reads** for read-only queries

**Actions** (`src/actions/`)
- Domain actions: `compute/` (VM creation), `network/`, `firewall/`, `services/`, `bootstrap/`
- Actions invoke Ansible or direct API calls for mutations

### Infrastructure Services (Docker Compose)

| Service    | Purpose              | Port |
|------------|----------------------|------|
| Neo4j      | Knowledge graph (twin) | 7687 |
| Qdrant     | Vector embeddings    | 6333 |
| Ollama     | Local LLM (optional) | 11434 |
| Prometheus | Metrics              | 9090 |
| Grafana    | Dashboards           | 3000 |

### Entry Points

- **CLI:** `src/cli.ts` — `agent`, `ask`, `pce`, `proxmox`, `opnsense`, `ssh`, `repl` subcommands
- **API Server:** `src/pce/api/main.ts` → `server.ts`
- **Dashboard:** `dashboard/index.html` + `dashboard/serve.ts`

## Environment Variables

Required in `.env`:
```
OPENAI_API_KEY=          # Language reasoning (data stays local)
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=
QDRANT_URL=http://localhost:6333

# Optional integrations
PROXMOX_URL=
PROXMOX_TOKEN_ID=
PROXMOX_TOKEN_SECRET=
OPNSENSE_URL=
OPNSENSE_API_KEY=
OPNSENSE_API_SECRET=
```

SSH credentials use per-host env vars: `SSH_USER_<IP>` and `SSH_PASSWORD_<IP>`.

## Tests

Tests live in `tests/` (Vitest). The `bun test` command discovers test files automatically. Integration tests that hit live infrastructure require a running environment with ingested data.
