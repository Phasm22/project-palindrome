# Palindrome

**Local-first agent for homelab automation**

Palindrome is an intelligent infrastructure assistant that helps you manage your homelab through natural language. It combines a digital twin of your infrastructure with AI-powered reasoning to answer questions, automate tasks, and provide insights—all while keeping your data local.

## What Palindrome Does

- **Query your infrastructure** - "What VMs are running on node YIN?" or "Show me all firewall rules"
- **Automate operations** - "Create a VM named testbox on node yin" or "Start VM 101"
- **Understand relationships** - See how VMs, networks, and firewall rules connect
- **Keep data local** - Your infrastructure data never leaves your network

## Quick Start

1. **Install dependencies** - Docker, Docker Compose, Bun
2. **Start services** - Docker Compose (Neo4j, Qdrant) + Palindrome API
3. **Access dashboard** - Open the web interface
4. **Start using** - Ask questions or run commands

**[Get Started →](docs/GETTING_STARTED.md)**

## Architecture

Palindrome is built on a **local-first** architecture:

- **Digital Twin** (Neo4j) - Graph database of your infrastructure
- **Vector Store** (Qdrant) - Semantic search over documentation and data
- **Agent** (LLM) - Natural language understanding and tool orchestration
- **Tools** - Proxmox, OPNsense, SSH integrations

**OpenAI is used as a "language reasoner" only** - sensitive infrastructure data never leaves your network.

## Documentation

- **[Getting Started](docs/GETTING_STARTED.md)** - Complete setup guide
- **[Architecture](docs/technical/architecture-implementation-complete.md)** - System design
- **[Roadmap](docs/ROADMAP.md)** - Development plans and current status
- **[Troubleshooting](docs/TROUBLESHOOTING.md)** - Common issues and solutions
- **[API Reference](docs/API_REFERENCE.md)** - API endpoints and usage

## Features

### Current Capabilities

**Infrastructure Queries**
- List VMs, nodes, networks, firewall rules
- Query by name, status, relationships
- Natural language questions

**VM Management**
- Create VMs from templates
- Start, stop, restart, destroy
- Multi-cluster support (YANG, YIN, proxBig)

**Network Operations**
- DNS record management (Pi-hole)
- DHCP to DNS synchronization
- VLAN configuration

**Service Automation**
- Install Docker, nginx, configure firewalls
- Bootstrap VMs with Ansible
- Static IP configuration

### Coming Soon

- Firewall rule management
- Resource management (CPU/memory/disk)
- Safety warnings and validation
- Posture checks and drift detection

## Deployment

Palindrome can run in several ways:

- **On-demand (TJ desktop)** — `pc-stacks up palindrome` (cold by default at login; see below)
- **Systemd Service** — `palindrome-services.service` (disabled at boot on TJ desktop; enable for always-on hosts)
- **Docker Compose** — All services containerized
- **Manual** — Run components individually

### Local runtime (on-demand / `pc-stacks`)

On TJ's Linux desktop the full stack (Neo4j, Qdrant, Docker Ollama, PCE API) is **not** auto-started at login.

```bash
pc-stacks up palindrome              # docker-compose.dev-lite + API :4000
PCE_INGESTION_ENABLED=1 pc-stacks up palindrome   # + 5-min ingestion scheduler
PC_STACKS_GRAFANA=1 pc-stacks up palindrome        # + prometheus/grafana profile
pc-stacks down palindrome
pc-stacks status
```

- **Orchestrator:** [`/home/tj/bin/pc-stacks`](/home/tj/bin/pc-stacks) — [`/home/tj/bin/README.md`](/home/tj/bin/README.md)
- **Ingestion** is off unless `PCE_INGESTION_ENABLED=1` (see `src/pce/scheduler/ingestion-scheduler.ts`).
- **Ollama** in compose uses `OLLAMA_KEEP_ALIVE=5m`; system `ollama.service` is disabled when Palindrome docker ollama is used.
- **Traceability:** PC Idle Quietdown plan (Cursor plans, Jul 2025).

See [Getting Started](docs/GETTING_STARTED.md) for detailed setup instructions.

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Start development services
bun run services:start

# Start API server
bun run pce:api

# Run agent CLI
bun run agent "list all VMs"
```

## License

Private project - not licensed for public use.

---

**Questions?** Check the [documentation](docs/) or [troubleshooting guide](docs/TROUBLESHOOTING.md).

