Good, then I’m going to treat that report as ground truth and just design the thing.

Below is the *manager-level* spec for Palindrome-as-digital-twin, in eight parts. No extra discovery, no implementation details.

---

## 1. Full System Architecture

**Conceptual layers**

1. **Ingestion Layer (Reality Tap)**

   * Proxmox API (read/write)
   * OPNsense (REST, MCP, SSH)
   * SSH for “last mile” (pfctl, OS-level, ZFS, etc.)
   * PCE external API (docs, configs, tickets)
   * Metrics exporters (future: Prometheus/node-exporter)
   * Event/log feeds (future: syslog, Wazuh, etc.)

2. **Parser & Canonicalization Layer**

   * Domain parsers convert raw outputs → typed entities
   * Normalization across sources (e.g., OPNsense + pfctl for firewall, Proxmox + guest for IPs)
   * Responsible for schema validation and de-duplication
   * No “opinions”, just facts

3. **Digital Twin / System Model Layer**

   * **Graph store** (Neo4j) for entities + relationships
   * **State store** (Postgres / KV) for entity snapshots + metadata
   * **Time-series** (future: Prometheus / TSDB) for metrics
   * Versioned state, diffs, annotations, and derived views

4. **PCE / Knowledge Layer**

   * Vector store (Qdrant) for semantic RAG
   * Graph-based retrieval for structural context and paths
   * Ontology-aware documents (playbooks, runbooks, design docs, configs)
   * Connects digital twin entities with docs and historical narratives

5. **Reasoning & Orchestration Layer**

   * Agent runner (your existing agent CLI + orchestrator)
   * Tool planner (decides which ingestion/model queries to run)
   * RAG orchestrator (Vector + Graph + Twin queries)
   * Chains for analysis, diagnosis, planning, and change simulation

6. **Interface Layer**

   * Palindrome Dashboard (web)
   * Agent CLI (e.g., `agent "<query>"`)
   * API (HTTP) for external integrations (tickets, alerts, webhooks)

**High-level flow**

```text
Real Systems
  ↓ (tools: proxmox/opnsense/ssh/pce-api)
Ingestion Layer
  ↓
Parser Layer (domain parsers)
  ↓
Digital Twin (entities + relations + time-series)
  ↕
PCE (semantic + structural RAG)
  ↓
LLM Reasoning + Orchestrator
  ↓
Dashboard / CLI / Incident / Automation
```

---

## 2. Repository / Directory Structure

Extend your existing layout into a domain-first, twin-centric structure.

```text
src/
  tools/
    proxmox/
      readonly/
      write/
    opnsense/
      readonly/
      safewrite/
      mcp/
    ssh/
    pce/
    common/
  parsers/
    compute/
      proxmox-vm-parser.ts
      proxmox-node-parser.ts
    network/
      opnsense-interface-parser.ts
      opnsense-route-parser.ts
      pfctl-firewall-parser.ts
    security/
      firewall-rules-parser.ts
      nat-rules-parser.ts
      vpn-status-parser.ts
    storage/
      zfs-pool-parser.ts
      proxmox-storage-parser.ts
    identity/        # future: users/keys/accounts
    metrics/         # future: Prometheus scraping parsers
    events/          # future: syslog/Wazuh/Caldera events
    topology/
      topology-yaml-parser.ts
      auto-discovery-parser.ts

  twin/
    models/
      entities.ts        # TS types/Zod schemas per entity
      relationships.ts   # relationship enums + constraints
    state/
      snapshot-store.ts  # current state read/write
      history-store.ts   # versioning, diffs
      derivations.ts     # derived views (e.g., “exposed services”)
    graph/
      neo4j-client.ts
      neo4j-repository.ts
    tsdb/
      metrics-client.ts  # future TSDB integration
    api/
      twin-query-service.ts
      twin-update-service.ts

  pce/
    rag/
      vector-retrieval.ts
      graph-retrieval.ts
      hybrid-orchestrator.ts
    context/
      context-builder.ts   # builds prompt context from twin + docs
      context-policies.ts

  reasoning/
    chains/
      describe-environment.ts
      investigate-incident.ts
      explain-change-impact.ts
      drift-analysis.ts
    planner/
      tool-planner.ts
      refresh-policy.ts      # stale-data detection
    prompts/
      system-prompts.ts
      domain-guidance.ts

  dashboard/
    api/
      dashboards-controller.ts
      queries-controller.ts
    ui/
      components/
      views/

  config/
    domains.yml             # entity/relationship registry
    twin-policies.yml       # refresh intervals, retention
    tool-whitelist.yml      # ssh commands, mcp operations
    metrics.yml             # which metrics to ingest

  tests/
    parsers/
    twin/
    tools/
    reasoning/
```

---

## 3. Parser Specs (Domain-Level)

This is the “what” — not the implementation.

### 3.1 Compute Parsers

**Proxmox VM Parser**

* **Input:** Proxmox `GET /nodes/{node}/qemu`, `GET /nodes/{node}/qemu/{vmid}/config`, `agent/network-get-interfaces`
* **Output Entity:** `ComputeVM`
* **Responsibilities:**

  * Normalize VM id, names, tags, node
  * Extract CPU, memory, disk, NICs
  * Map guest-reported IPs to interfaces
  * Mark agent availability

**Proxmox Node Parser**

* **Input:** `GET /nodes`, `GET /nodes/{node}/status`
* **Output Entity:** `ComputeNode`
* **Responsibilities:**

  * Node role, resources, cluster membership
  * Hypervisor version, uptime
  * Node-level tags (lab/home/etc.)

### 3.2 Network Parsers

**OPNsense Interface Parser**

* **Input:** OPNsense API (interfaces, assignments), `ifconfig`
* **Output:** `NetworkInterface`, `NetworkSubnet`
* **Responsibilities:**

  * Normalize names (vtnet0, VLANs) across systems
  * Map interfaces to subnets and gateways
  * Identify WAN/LAN/SECURITY roles

**Routing Parser**

* **Input:** OPNsense diagnostics routes, `netstat -rn`
* **Output:** `NetworkRoute`
* **Responsibilities:**

  * Represent routing table in canonical form
  * Mark default routes, static vs dynamic

### 3.3 Security / Firewall Parsers

**Firewall Rules Parser (pfctl)**

* **Input:** `pfctl -sr`, `pfctl -sn`, `pfctl -sa`
* **Output:** `FirewallRule`, `FirewallAnchor`, `FirewallRuleSet`
* **Responsibilities:**

  * Parse all rules (user + built-in)
  * Classify as allow/deny/other, floating vs interface
  * Attach anchor, interface, direction, protocol
  * Provide canonical rule ordering

**VPN Status Parser (future)**

* Map VPN tunnels, peers, and associated subnets.

### 3.4 Storage Parsers

**ZFS Pool Parser**

* **Input:** `zpool status`, `zfs list`
* **Output:** `StoragePool`, `StorageVolume`
* **Responsibilities:**

  * Represent pools, datasets, health
  * Map storage to nodes and VMs (where possible)

### 3.5 Metrics Parsers (Future)

**Prometheus Metric Parser**

* **Input:** Prometheus API (e.g., node_exporter metrics)
* **Output:** `MetricSeries`
* **Responsibilities:**

  * Tag metrics with entity_id (node, VM, etc.)
  * Enforce naming conventions

### 3.6 Events Parsers (Future)

Log/syslog/Wazuh/Caldera parsers producing `Event` entities tied to twin entities.

---

## 4. Canonical Entity Schemas (Core Types)

High-level, not strict TS, but enough to define shape.

### 4.1 Compute

**ComputeNode**

* `id`
* `name`
* `roles` (hypervisor, router, storage, etc.)
* `ips` (management + data)
* `resources` (cpu_total, mem_total, storage_total)
* `provider` (proxmox, baremetal, cloud)
* `status` (online, degraded, offline)
* `tags` (lab, home, etc.)

**ComputeVM**

* `id`
* `name`
* `node_id` (FK → ComputeNode)
* `state` (running, stopped, paused)
* `resources` (cpu, mem, disk)
* `interfaces` (list of NIC references)
* `agent_available` (bool)
* `ips` (by interface)
* `purpose` (optional/derived: dc, wazuh, caldera, etc.)
* `tags`

### 4.2 Network

**NetworkInterface**

* `id`
* `name`
* `node_id` or `vm_id`
* `mac`
* `ips` (v4/v6)
* `vlan_id`
* `role` (wan, lan, lab, mgmt, etc.)

**NetworkSubnet**

* `id`
* `cidr`
* `gateway_ip`
* `vlan_id`
* `purpose` (lab, home, dmz)
* `dns_servers`
* `dhcp_range`

**NetworkRoute**

* `id`
* `destination_cidr`
* `gateway_ip`
* `metric`
* `source_device` (interface or node)

### 4.3 Security

**FirewallRule**

* `id` (stable hash or UUID)
* `order`
* `action` (pass, block, reject)
* `direction` (in, out)
* `interface_id` (nullable for floating)
* `source` (cidr, alias, any)
* `destination` (cidr, alias, any)
* `protocol`
* `ports` (src/dst)
* `label`
* `is_builtin` (bool)
* `anchor_id` (optional)
* `enabled` (bool)

**FirewallNatRule**

* similar structure, plus `nat_type`, `translated_ip`, `translated_port`.

### 4.4 Storage

**StoragePool**

* `id`
* `name`
* `node_id`
* `type` (zfs, lvm, dir)
* `capacity_total`
* `capacity_used`
* `status`

**StorageVolume**

* `id`
* `pool_id`
* `name`
* `size`
* `attached_to` (VM or node)

### 4.5 Topology

**TopologyNode**

* `entity_ref` (id + type)
* `display_name`
* `category` (compute, network, firewall, service)
* `zone` (home, lab, dmz)
* `importance`

**TopologyEdge**

* `source_entity_ref`
* `target_entity_ref`
* `relation_type` (runs_on, connected_to, protected_by, depends_on)
* `directionality` (uni/bidirectional)

### 4.6 Metrics

**MetricSeries**

* `id`
* `entity_ref`
* `metric_name`
* `labels`
* `values` (time/value pairs, or TSDB reference)

### 4.7 Events

**Event**

* `id`
* `timestamp`
* `entity_ref` (optional)
* `severity`
* `kind` (alert, info, change, anomaly)
* `source` (wazuh, syslog, caldera, internal)
* `message`
* `context` (structured fields)

---

## 5. Cross-Domain Ontology (Relationships)

Key relationships the twin must support:

* **ComputeNode —hosts→ ComputeVM**
* **ComputeVM —has_interface→ NetworkInterface**
* **NetworkInterface —in_subnet→ NetworkSubnet**
* **NetworkSubnet —uses_gateway→ NetworkInterface (on firewall/node)**
* **FirewallRule —applies_to→ NetworkInterface / NetworkSubnet**
* **FirewallRule —protects→ ComputeVM / Subnet (derived)**
* **StoragePool —resides_on→ ComputeNode**
* **StorageVolume —backs→ ComputeVM disk**
* **MetricSeries —measures→ any entity_ref**
* **Event —about→ any entity_ref**
* **TopologyEdge** mirrors the above, but dedicated to graph visualization.

This ontology is your “world model” and underpins queries like:

* “Show all VMs in lab network that are exposed via any allow rule from WAN.”
* “What changed between twin snapshot T-1 and now.”

---

## 6. Ingestion Pipelines

### 6.1 Modes

* **On-demand:** Tool calls triggered by agent queries (e.g., “what’s the state of X?”)
* **Scheduled:** Background refresh (e.g., every N minutes per domain)
* **Event-triggered (future):** Webhooks, SNMP traps, alerts

### 6.2 Standard Pipeline Stages

For any domain:

```text
tool_call → raw_output → parser → entities → twin_update → (optional) diff → (optional) triggers
```

### 6.3 Domain Examples

**Compute/Proxmox:**

* Scheduled: every 2–5 minutes
* Tools: `proxmox_readonly`
* Parsers: node + VM parsers
* Twin updates: Node and VM entities; relationships Node→VM, VM→Interface

**Network/OPNsense:**

* Firewall rules: less frequent (e.g., every 5–10 min or on-demand)
* Interfaces/routes: 1–5 min
* Mixed sources: OPNsense API + SSH results
* Twin updates: FirewallRule, NetworkInterface, NetworkRoute

**Storage:**

* ZFS, Proxmox storage: 10–15 min (slower changing)
* Twin updates: StoragePool, StorageVolume

**Metrics:**

* Prometheus scrapings: 15–60s if/when added
* Twin updates: MetricSeries references (or just store labels and let TSDB handle retrieval)

**Events:**

* Ingest as they arrive, parse, and attach to entities.

---

## 7. LLM Reasoning Chains

You already have an agent + tools; this formalizes chains on top of the twin.

### 7.1 Chain Types

1. **Describe Environment**

   * Query twin for current state
   * Summarize per domain (compute, network, security)
   * Pull docs from PCE for contextualization
   * Output: natural-language “state of the world”

2. **Investigate Incident**

   * Input: event (alert, log, anomaly)
   * Steps:

     * Resolve entity_ref(s) from the twin
     * Fetch related metrics, rules, topology
     * Pull relevant docs and past incidents
     * Explain likely cause and blast radius
     * Suggest next steps / tool calls

3. **Explain Change Impact**

   * Input: proposed change (e.g., new rule, moving VM)
   * Steps:

     * Simulate change on the twin graph (offline snapshot)
     * Answer: “Which paths or entities are affected?”
     * Present risk and conflicts

4. **Drift Analysis**

   * Compare current twin snapshot vs previous
   * Summarize:

     * new VMs, missing VMs
     * rule changes
     * route changes
     * storage health changes
   * Output: change report with severity ranking

5. **Topology & Exposure Analysis**

   * Given a VM/service, walk graph:

     * inbound paths from WAN
     * firewall rules along path
     * VPN involvement
   * Output: exposure explanation and misconfig detection.

### 7.2 Chains Use:

* **Twin queries** (primary)
* **Graph and vector RAG** (for docs + context)
* **Tools only when data is stale** (refresh-policy module)

---

## 8. Digital Twin Engine Spec

This is the subsystem that turns ingested data into a living world model.

### 8.1 Core Components

1. **Twin State Manager**

   * Holds canonical entities in memory and persistent store
   * Applies updates from parsers
   * Enforces schemas and type constraints

2. **Graph Backend (Neo4j)**

   * Stores entity nodes and relationships
   * Provides graph queries (paths, neighborhoods)

3. **Snapshot & History Store**

   * Tracks versions (snapshots) of the twin
   * Supports “as-of” queries
   * Computes diffs between snapshots

4. **Metrics Adapter (future)**

   * Integrates TSDB (Prometheus/Influx/etc.)
   * Links metrics to twin entities

5. **Twin API**

   * `get_entity`, `get_neighbors`, `get_subgraph`
   * `query_by_attribute` (e.g., all VMs in subnet X)
   * `get_snapshot`, `diff_snapshots`
   * `update_entities` (internal only, from parsers)

6. **Policy Engine**

   * Refresh policies (how often to pull real world)
   * Retention policies (how long to keep history)
   * Trigger policies (when to fire reasoning chains)

### 8.2 Data Flow

```text
Parsers → Twin State Manager → Graph + State Stores
LLM/Agent → Twin API → Graph/State/TSDB
Events/Metrics → Twin State Manager → updated entities + derived flags
```

### 8.3 Non-Goals (for now)

* No auto-remediation in the engine itself
* No hard real-time guarantees
* No full-blown SIEM — but it can feed one

---

That’s the design layer: architecture, layout, entities, ontology, pipelines, reasoning patterns, and the twin engine’s responsibilities.

Next step (when you’re ready) is to pick **one vertical slice** (e.g., “Firewall + VM exposure analysis”) and drive it end-to-end through this model.
