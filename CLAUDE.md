# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime & Tooling

- **Bun** is the runtime and package manager (not Node.js/npm). Use `bun` for all commands.
- TypeScript files are executed directly via Bun — no separate compile step.
- Tests use **Vitest** but are run through Bun: `bun test`
- To run a single test file: `bun test tests/reasoning/some-test.ts`

## Host runtime (`pc-stacks`)

On TJ's Linux desktop the full stack is **cold at login**. Before API/tools work:

```bash
pc-stacks up palindrome
PCE_INGESTION_ENABLED=1 pc-stacks up palindrome   # enable 5-min ingestion
pc-stacks status
```

See [README.md](README.md#local-runtime-on-demand--pc-stacks) and [`/home/tj/bin/README.md`](/home/tj/bin/README.md). Traceability: PC Idle Quietdown plan (Cursor plans, Jul 2025).

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
- `tool-loader.ts` — registers the 17 available tools into agent context
- `tool-policy.ts` — ACL groups (`admin`, `ops`, `viewer`, `sre`, `security`, `helpdesk`) and risk stratification; high-risk ops require confirmation
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
- `opnsense/readonly/` and `opnsense/writes/` — Firewall rules
- `pihole/readonly/` — DNS reads (Pi-hole serves DNS, not OPNsense): records, top domains/clients, query log, blocking status
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

# LLM intent classification is always on (generateObject); flag no longer gates the path
INTENT_CLASSIFIER_MODEL=gpt-4o-mini # Model for intent classification

# Main tool-calling/reasoning loop model (default gpt-4o as of 2026-07-22 —
# an eval found gpt-4o-mini reliably merges tool-result aggregate totals
# (e.g. total_queries) into a specific entity's row in TERSE_DATA answers;
# plain gpt-4o avoided this without any prompt change, at similar latency)
AGENT_CHAT_MODEL=gpt-4o
```
Composite queries (e.g. "VMs on yang exposed to internet", "nodes and their exposure level") are detected via `isLikelyCompositeQuery()` and classification metadata `composite: true`. For those, the runner skips twin-first chains and uses the EXECUTE path so the LLM can coordinate multiple tools. For composite queries, RAG is allowed (tool_first_domain is not applied) and a multi-step system instruction is injected so the agent uses multiple tools and synthesizes one answer.

SSH credentials use per-host env vars: `SSH_USER_<IP>` and `SSH_PASSWORD_<IP>`.

## Tests

Tests live in `tests/` (Vitest). The `bun test` command discovers test files automatically. Integration tests that hit live infrastructure require a running environment with ingested data.
