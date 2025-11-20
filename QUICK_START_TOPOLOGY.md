# Quick Start: Topology Ingestion

## 1. Fill in topology.yaml

Use the template at `docs/topology.yaml.template` or edit `docs/topology.yaml` directly.

**Minimum required fields:**
- `hosts` - At least one host
- `networks` - At least one network

**Example minimal topology.yaml:**

```yaml
networks:
  lab:
    cidr: "172.16.0.0/22"
    gateway: "172.16.0.1"

hosts:
  - name: "level"
    role: "proxmox"
    ip: "172.16.0.10"
    network: "lab"
```

## 2. Ingest Topology

```bash
bun run scripts/ingest-topology.ts
```

Or with custom settings:

```bash
TOPOLOGY_PATH=docs/topology.yaml \
NEO4J_URI=bolt://localhost:7687 \
NEO4J_USER=neo4j \
NEO4J_PASSWORD=yourpassword \
bun run scripts/ingest-topology.ts
```

## 3. Query Dependencies

After ingestion, you can query:

- **"What depends on pihole?"** - Find all dependents
- **"What breaks if level goes down?"** - Find dependency chain
- **"Map the dependencies of sentinelZero"** - Find all dependencies

## Example: Full Topology with Dependencies

```yaml
networks:
  lab:
    cidr: "172.16.0.0/22"
    vlan: 50
    gateway: "172.16.0.1"

hosts:
  - name: "level"
    role: "proxmox"
    ip: "172.16.0.10"
    network: "lab"
  
  - name: "civic"
    role: "pihole"
    ip: "192.168.71.13"
    network: "mgmt"

containers:
  - name: "sentinelZero"
    type: "docker"
    host: "level"
    depends_on:
      - "pihole"
      - "wireguard"

services:
  - name: "dns"
    port: 53
    protocol: "udp"
    host: "civic"
```

This will create:
- Network and Host nodes
- Container nodes with DEPENDS_ON relationships
- Service nodes with RUNS_ON relationships
- All connected via the graph

