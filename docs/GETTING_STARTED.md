# Getting Started with Palindrome

This guide will help you get Palindrome up and running. Follow these steps in order.

## Prerequisites

Before you begin, ensure you have:

- **Docker** and **Docker Compose** installed
- **Bun** runtime installed ([install Bun](https://bun.sh))
- **Network access** to your Proxmox and OPNsense systems (if using)
- **API tokens** configured for Proxmox/OPNsense (if using)

### Quick Prerequisites Check

```bash
# Check Docker
docker --version
docker compose version

# Check Bun
bun --version

# If missing, see installation guides:
# - Docker: docs/INSTALL_DOCKER.md (if exists) or Docker docs
# - Bun: https://bun.sh/docs/installation
```

## Step 1: Clone and Install

```bash
# Clone the repository (if not already)
cd /path/to/project-palindrome

# Install dependencies
bun install
```

## Step 2: Configure Environment

Create a `.env` file in the project root with your configuration:

```bash
# Copy example if available, or create manually
cp .env.example .env  # if exists

# Required: OpenAI API key (used for language reasoning only)
OPENAI_API_KEY=your_key_here

# Required: Database URLs
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=your_password

QDRANT_URL=http://localhost:6333

# Optional: Proxmox configuration
PROXMOX_URL=https://your-proxmox:8006/api2/json
PROXMOX_TOKEN_ID=user@pve!token-name
PROXMOX_TOKEN_SECRET=your_secret

# Optional: OPNsense configuration
OPNSENSE_URL=https://your-opnsense
OPNSENSE_API_KEY=your_key
OPNSENSE_API_SECRET=your_secret
```

**Note:** See [Troubleshooting](TROUBLESHOOTING.md) for detailed configuration help.

## Step 3: Start Services

Palindrome requires several services to run. Choose your deployment method:

### Option A: Systemd Service (Recommended for Production)

Run Palindrome as a background service that starts automatically:

```bash
# Install the service
sudo bash scripts/install-systemd-service.sh

# Enable and start
sudo systemctl enable palindrome-services
sudo systemctl start palindrome-services

# Check status
sudo systemctl status palindrome-services
```

See [Systemd Setup](SYSTEMD_SETUP.md) for detailed instructions.

### Option B: Docker Compose + Manual Start

Start services manually:

```bash
# Start Docker services (Neo4j, Qdrant)
docker compose up -d

# Wait for services to be ready (about 10-30 seconds)
docker compose ps

# Start Palindrome API
bun run pce:api

# In another terminal, start the dashboard
bun run dashboard:serve
```

### Option C: All-in-One Script

Use the start script to launch everything:

```bash
bun run scripts/start-all.ts
```

## Step 4: Verify Installation

### Check Service Health

```bash
# Check Docker services
docker compose ps

# Check API health (should return 200)
curl http://localhost:4000/health

# Or visit in browser
open http://localhost:4000/health
```

### Access the Dashboard

Open the dashboard in your browser:

- **Local file:** Open `dashboard/index.html` directly
- **Or via server:** If running `dashboard:serve`, visit the URL shown
- **Default API URL:** `http://localhost:4000` (configured in dashboard)

## Step 5: Initial Ingestion

Before you can query your infrastructure, Palindrome needs to ingest data:

```bash
# Ingest all infrastructure data
bun run pce:ingest-all

# Or ingest specific domains
bun run pce:ingest-proxmox    # Proxmox VMs and nodes
bun run pce:ingest-network    # Network interfaces
bun run pce:ingest-firewall   # Firewall rules
```

**What this does:**
- Connects to your Proxmox/OPNsense systems
- Collects current infrastructure state
- Stores it in the digital twin (Neo4j)
- Indexes it for semantic search (Qdrant)

## Step 6: Start Using Palindrome

### Via Dashboard

1. Open the dashboard in your browser
2. Go to the **Chat** tab
3. Ask questions like:
   - "What VMs are running?"
   - "Show me all nodes"
   - "What's the IP of windowsVM?"

### Via CLI

```bash
# Run the agent CLI
bun run agent "list all VMs"

# Or use the bin alias
agent "what VMs are on node YIN?"
```

### Via API

```bash
# Query endpoint
curl -X POST http://localhost:4000/api/agent/stream \
  -H "Content-Type: application/json" \
  -d '{"userInput": "list all VMs", "sessionId": "test-123"}'
```

## Next Steps

### Learn More

- **[Architecture Overview](technical/architecture-implementation-complete.md)** - Understand how Palindrome works
- **[Roadmap](ROADMAP.md)** - See what's planned and current status
- **[Tool Documentation](tools/)** - Learn about available tools
- **[API Reference](API_REFERENCE.md)** - API endpoints and usage

### Common Tasks

- **Query infrastructure:** Use natural language in the dashboard or CLI
- **Create VMs:** "Create a VM named testbox on node yin"
- **Manage services:** "Install Docker on VM 101"
- **Troubleshoot:** See [Troubleshooting Guide](TROUBLESHOOTING.md)

### Automation

Set up scheduled ingestion to keep your digital twin up to date:

```bash
# Add to crontab (runs every 5 minutes)
*/5 * * * * cd /path/to/project-palindrome && bun run pce:ingest-all >> /var/log/palindrome-ingestion.log 2>&1
```

See [Ingestion Strategy](INGESTION_STRATEGY.md) for more options.

## Troubleshooting

If you encounter issues:

1. **Check service status:**
   ```bash
   docker compose ps
   sudo systemctl status palindrome-services  # if using systemd
   ```

2. **Check logs:**
   ```bash
   docker compose logs
   sudo journalctl -u palindrome-services -f  # if using systemd
   ```

3. **Verify configuration:**
   - Check `.env` file has all required variables
   - Verify API tokens are valid
   - Ensure network connectivity to Proxmox/OPNsense

4. **See [Troubleshooting Guide](TROUBLESHOOTING.md)** for common issues and solutions

## Getting Help

- **Documentation:** Browse the [docs](/) directory
- **Troubleshooting:** See [TROUBLESHOOTING.md](TROUBLESHOOTING.md)
- **Architecture:** See [technical documentation](technical/)

---

**Ready to go?** Start with a simple query: "What VMs are running?"

