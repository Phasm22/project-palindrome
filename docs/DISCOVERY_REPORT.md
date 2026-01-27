# Project Palindrome - Comprehensive Discovery Report

**Version:** 0.1  
**Date:** 2025-01-27  
**Scope:** Initial discovery to map current capabilities, gaps, and structure in preparation for full digital-twin-based infrastructure intelligence architecture.

---

## Executive Summary

Project Palindrome is a sophisticated infrastructure intelligence platform that combines:
- **Hybrid RAG** (Vector + Graph) for semantic and structural retrieval
- **Multi-domain tooling** (Proxmox, OPNsense, SSH, MCP) for infrastructure access
- **Knowledge graph** (Neo4j) for relationship modeling
- **Vector store** (Qdrant) for semantic search
- **Agentic reasoning** with LLM-powered tool orchestration

**Current State:** Phase III complete - External API, cognitive automation, and provenance tracking operational. Foundation is solid but gaps exist in temporal tracking, storage domain coverage, and comprehensive network topology modeling.

---

## 1. INGESTION LAYER: Tools & Raw Data Sources

### 1.1 Available Tools

**Core Tools (9 total):**
1. **`proxmox_readonly`** - Proxmox VE read-only operations
   - **Coverage:** 18 actions (nodes, VMs, cluster, system)
   - **APIs:** Proxmox REST API via `ProxmoxClient`
   - **Status:** ✅ Fully operational, normalized outputs
   - **Location:** `src/tools/proxmox/readonly/proxmox-readonly-tool.ts`

2. **`proxmox_write`** - Proxmox VE write operations
   - **Coverage:** VM lifecycle (start, stop, migrate, clone, snapshot)
   - **Status:** ✅ Operational with confirmation requirements
   - **Location:** `src/tools/proxmox/writes/proxmox-write-tool.ts`

3. **`opnsense_readonly`** - OPNsense read-only operations
   - **Coverage:** 20+ actions (firewall, interfaces, system, diagnostics, DHCP)
   - **APIs:** REST API (limited ~20-30% coverage) + SSH fallback for firewall rules
   - **Status:** ✅ Operational, uses SSH internally for `firewall_rules_list` (parallelized)
   - **Location:** `src/tools/opnsense/readonly/opnsense-readonly-tool.ts`
   - **Note:** Firewall rules via `pfctl` commands (parallelized, ~10s)

4. **`opnsense_safewrite`** - OPNsense controlled write operations
   - **Coverage:** Alias creation, rule enable/disable, description updates
   - **Status:** ✅ Operational with confirmation requirements
   - **Location:** `src/tools/opnsense/writes/opnsense-safewrite-tool.ts`

5. **`mcp_opnsense`** - MCP server integration for OPNsense
   - **Coverage:** Partial (~24 tools discovered)
   - **Status:** ⚠️ Partial coverage, firewall rules listing returns 404
   - **Location:** `src/tools/MCPOpnsenseTool.ts`
   - **Note:** Convenience tool, not full replacement

6. **`ssh_execute`** - OS-level operations via SSH
   - **Coverage:** Disk, resources, sensors, logs, system commands
   - **Status:** ✅ Operational with approved command whitelist
   - **Location:** `src/tools/SSHTool.ts`
   - **Approved Commands:** `src/config/approved-commands.yaml`

7. **`run_diagnostic_command`** - Network diagnostics
   - **Coverage:** ping, traceroute, HTTP checks
   - **Status:** ✅ Operational
   - **Location:** `src/tools/RunDiagnosticTool.ts`

8. **`lookup_user_profile`** - Directory metadata
   - **Status:** ✅ Operational
   - **Location:** `src/tools/LookupUserProfileTool.ts`

9. **`create_incident_ticket`** - Incident management
   - **Status:** ✅ Operational (requires approval)
   - **Location:** `src/tools/CreateIncidentTicketTool.ts`

### 1.2 Tool Reliability Assessment

| Tool | Reliability | Notes |
|------|------------|-------|
| `proxmox_readonly` | ✅ High | Well-tested, normalized outputs, provenance tracking |
| `proxmox_write` | ✅ High | Confirmation required, safe operations |
| `opnsense_readonly` | ⚠️ Medium | REST API limited, SSH fallback for firewall rules |
| `opnsense_safewrite` | ✅ High | Controlled writes with rollback |
| `mcp_opnsense` | ⚠️ Low | Partial coverage, some endpoints return 404 |
| `ssh_execute` | ✅ High | Whitelisted commands, parallel execution support |
| `run_diagnostic_command` | ✅ High | Simple, reliable |
| `lookup_user_profile` | ✅ High | Simple directory lookup |
| `create_incident_ticket` | ✅ High | Approval-gated |

### 1.3 Tool Output Formats

- **Proxmox:** Normalized JSON (human-friendly units, sanitized secrets)
- **OPNsense:** Structured JSON (firewall rules, aliases, system status)
- **SSH:** Text output (stdout/stderr), parsed where applicable
- **MCP:** JSON responses (varies by endpoint)

### 1.4 New Tools Required

**Missing/Incomplete:**
- ❌ **Storage tools:** ZFS pool/volume state, snapshot metadata, backup status
- ❌ **Network topology tools:** Switch configuration, VLAN mapping, routing table ingestion
- ❌ **Metrics collectors:** Node exporter integration, custom metric ingestion
- ❌ **Event log collectors:** Syslog, Suricata, audit log ingestion
- ❌ **DHCP/DNS tools:** DHCP lease tracking, DNS record management

---

## 2. COMPUTE DOMAIN

### 2.1 Compute Nodes

**Proxmox Nodes Identified:**
- `proxBig` (172.16.0.10) - Proxmox VE node
- `yin` (172.16.0.11) - Proxmox VE node  
- `yang` (172.16.0.12) - Proxmox VE node

**APIs Available:**
- ✅ Proxmox REST API (via `proxmox_readonly` tool)
- ✅ SSH access (via `ssh_execute` tool)
- ✅ Guest agent (for VM IP resolution)

**Metrics Sources:**
- ⚠️ **Limited:** Proxmox API provides CPU/memory/disk stats
- ❌ **Missing:** Node exporter integration, Prometheus scraping
- ❌ **Missing:** Time-series resource state collection

### 2.2 VMs & Containers

**Current Capabilities:**
- ✅ VM/container inventory via `proxmox_readonly list_vms`
- ✅ VM status, config, network, snapshots
- ✅ IP resolution via guest agent (with SSH fallback)
- ✅ Cluster-wide resource discovery

**Gaps:**
- ❌ **OS detection:** Not systematically tracked
- ❌ **Purpose/criticality:** Not in ontology
- ❌ **NIC-to-VLAN mapping:** Partial (network config available, VLAN not extracted)
- ❌ **Time-series state:** No historical resource usage tracking

### 2.3 Time-Series Resource State

**Status:** ❌ **Not Collected**

**Current State:**
- Proxmox API provides current state only
- No Prometheus/node-exporter integration
- No time-series database (InfluxDB, TimescaleDB, etc.)

**Recommendation:**
- Integrate Prometheus node exporter
- Scrape Proxmox metrics endpoints
- Store in time-series DB for historical analysis

---

## 3. NETWORK DOMAIN

### 3.1 Networking Devices

**Identified:**
- **OPNsense** (`opnsense_gw`, 172.16.0.1) - Firewall/router
- **Cisco 2960G** switch (172.16.0.9, 192.168.71.6) - VLAN trunking

**APIs Available:**
- ✅ OPNsense REST API (limited coverage)
- ✅ OPNsense SSH (for firewall rules via `pfctl`)
- ✅ MCP server (partial coverage)
- ❌ Switch management API (not integrated)

### 3.2 VLANs, Subnets, Gateways

**Current State:**
- ✅ **Topology YAML:** `docs/topology.yaml` defines networks, VLANs, subnets
  - `home` network: 192.168.68.0/22, VLAN 1, gateway 192.168.68.1
  - `lab` network: 172.16.0.0/22, VLAN 50, gateway 172.16.0.1
- ✅ **Topology Ingestion:** `src/pce/ingestion/topology-ingestion.ts` extracts Network and VLAN nodes
- ⚠️ **Live Discovery:** Not automatically discovered from OPNsense/switch

**Gaps:**
- ❌ OPNsense VLAN configuration not ingested
- ❌ Switch VLAN trunk configuration not ingested
- ❌ DHCP subnet configuration not tracked
- ❌ Routing rules not systematically extracted

### 3.3 DHCP, DNS, VPN

**DHCP:**
- ✅ `opnsense_readonly dhcp_leases_list` - Available but unstable per docs
- ✅ `opnsense_readonly dhcp_static_mappings_list` - Available
- ❌ Historical lease tracking - Not stored

**DNS:**
- ✅ Pi-hole instances identified in topology (lab_pihole, home_dns)
- ❌ DNS record management - Not integrated
- ❌ DNS query logs - Not collected

**VPN:**
- ✅ WireGuard configuration in topology YAML
- ✅ Service definition (port 51820 on opnsense_gw)
- ❌ VPN client state - Not tracked
- ❌ VPN connection logs - Not collected

### 3.4 Network Topology in Palindrome

**Status:** ✅ **Partially Maintained**

**Current Implementation:**
- Topology YAML ingestion creates Network, VLAN, Host nodes
- Relationships: `CONNECTS_TO`, `BELONGS_TO`, `RUNS_ON`, `HOSTS`
- Graph storage in Neo4j

**Gaps:**
- ❌ Live topology discovery from devices
- ❌ Switch port-to-VLAN mapping
- ❌ Path queries (reachability analysis)
- ❌ Network dependency graph

---

## 4. SECURITY DOMAIN

### 4.1 Firewall Rules

**Sources:**
1. ✅ **SSH + pfctl** (PRIMARY) - `opnsense_readonly firewall_rules_list`
   - Uses `pfctl -sr` (rules), `pfctl -sn` (NAT), `pfctl -si` (info)
   - Parallelized execution (~10s total)
   - Location: `src/tools/opnsense/readonly/opnsense-readonly-tool.ts:654-709`

2. ⚠️ **REST API** - Limited coverage (~20-30% of backend)
   - Missing: `/api/firewall/rule/search`, `/api/firewall/rule/list`
   - Available: `/api/firewall/rule/getRule/{uuid}` (single rule)

3. ⚠️ **MCP** - Returns 404 for firewall rules listing

**Current State:**
- ✅ Rules extracted and parsed
- ✅ NAT rules extracted
- ❌ **Rule interpretation:** Raw `pfctl` output, not fully parsed into structured format
- ❌ **Historical rule states:** Not stored

### 4.2 NAT Rules

**Status:** ✅ **Extracted via SSH**

- `pfctl -sn` command extracts NAT rules
- Included in `firewall_rules_list` response
- ❌ Not separately stored or versioned

### 4.3 Event Logs

**Status:** ❌ **Not Collected**

**Missing:**
- Suricata IDS logs
- Syslog aggregation
- Firewall state logs
- Authentication logs
- Security event correlation

**Recommendation:**
- Integrate syslog collector
- Parse Suricata logs
- Store in time-series or log aggregation system

---

## 5. STORAGE DOMAIN

### 5.1 Storage Pools

**Status:** ⚠️ **Partial Coverage**

**Current Capabilities:**
- ✅ `proxmox_readonly node_storage` - Lists storage pools per node
- ✅ Storage type, content types, nodes available
- ✅ Graph entities: `PVE_STORAGE` nodes with `USES` and `CONNECTED_TO` relationships

**Gaps:**
- ❌ **ZFS pool state:** Not extracted (pool health, usage, snapshots)
- ❌ **Volume metadata:** Not systematically tracked
- ❌ **Backup metadata:** Not ingested
- ❌ **Snapshot history:** VM snapshots available, but storage-level snapshots not tracked

### 5.2 ZFS/Volume State

**Status:** ❌ **Not Collected**

**Missing:**
- ZFS pool status (`zpool status`)
- ZFS dataset information
- Volume usage and health
- Storage I/O metrics

**Recommendation:**
- Add SSH tool actions for ZFS commands
- Parse `zpool list`, `zfs list`, `zpool status`
- Ingest into graph as storage entities

### 5.3 Snapshot & Backup Metadata

**VM Snapshots:**
- ✅ `proxmox_readonly get_vm_snapshots` - Available
- ✅ Snapshot names, parents, timestamps
- ❌ Snapshot size/space usage - Not extracted

**Storage Snapshots:**
- ❌ ZFS snapshot metadata - Not collected
- ❌ Backup job status - Not tracked
- ❌ Backup retention policies - Not ingested

---

## 6. TOPOLOGY & GRAPH MODEL

### 6.1 Current Entities in Palindrome

**Node Types (from ontology):**
- `HOST` - Physical hosts
- `VM` - Virtual machines (generic)
- `VM_INSTANCE` - Proxmox VM instances (vmid, node, type)
- `CONTAINER` - Containers (LXC, Docker, etc.)
- `SERVICE` - Network services
- `VLAN` - VLAN definitions
- `NETWORK` - Network subnets/CIDRs
- `PVE_NODE` - Proxmox nodes
- `PVE_STORAGE` - Proxmox storage pools
- `FIREWALL_RULE` - Firewall rules
- `ALERT` - Alerts
- `USER` - Users
- `DEPENDENCY` - Service dependencies
- `CONFIG` - Configuration items

**Relationship Types:**
- `HOSTS_ON` - VM hosted on node
- `RUNS_ON` - Service/container runs on host
- `CONNECTS_TO` - Network connections
- `BELONGS_TO` - Network belongs to VLAN
- `USES` - VM uses storage
- `CONNECTED_TO` - Storage connected to node
- `DEPENDS_ON` - Dependencies
- `HOSTS` - Node hosts VM/container
- `CONFIGURED_BY` - Configuration relationships
- `AFFECTS`, `TRIGGERS`, `ACCESSES`, `OWNS`, `LOGGED_BY`

### 6.2 Current Relationships

**Proxmox Relationships:**
- ✅ `VM_INSTANCE HOSTS_ON PVE_NODE`
- ✅ `VM_INSTANCE USES PVE_STORAGE`
- ✅ `PVE_STORAGE CONNECTED_TO PVE_NODE`

**Topology Relationships:**
- ✅ `HOST CONNECTS_TO NETWORK`
- ✅ `NETWORK BELONGS_TO VLAN`
- ✅ `CONTAINER RUNS_ON HOST`
- ✅ `SERVICE RUNS_ON HOST`

**Gaps:**
- ❌ `NIC CONNECTS_TO VLAN` - Not extracted
- ❌ `FIREWALL_RULE AFFECTS NETWORK` - Not linked
- ❌ `VM DEPENDS_ON SERVICE` - Not inferred

### 6.3 Graph Update Strategy

**Current:**
- ✅ **Scheduled ingestion:** `bun run pce:ingest-proxmox`
- ✅ **Topology ingestion:** Via `extractTopologyEntities()`
- ⚠️ **Live updates:** Webhook listener exists but not fully integrated
- ❌ **Change-driven triggers:** Not implemented

**Recommendation:**
- Implement webhook-driven updates for Proxmox events
- Add change detection for topology YAML
- Trigger graph updates on tool execution results

### 6.4 Path Queries

**Status:** ❌ **Not Implemented**

**Missing:**
- Reachability analysis (can VM A reach VM B?)
- Network path queries
- Dependency chain traversal
- Impact analysis (what breaks if X fails?)

**Recommendation:**
- Implement Cypher queries for path analysis
- Add graph traversal utilities
- Build reachability API endpoint

---

## 7. METRICS & OBSERVABILITY

### 7.1 Metric Sources

**Current:**
- ✅ **Palindrome API metrics:** `/metrics` endpoint (Prometheus format)
  - Query latency, ingestion throughput, error rates
  - Location: `src/pce/api/server.ts:359-437`
- ✅ **Prometheus config:** `prometheus/prometheus.yml`
  - Scrapes Palindrome API at `localhost:4000/metrics`
- ⚠️ **Grafana:** Configured but dashboards minimal
  - Location: `grafana/dashboards/pce-overview.json`

**Missing:**
- ❌ **Node exporter:** Not integrated
- ❌ **Proxmox exporter:** Not integrated
- ❌ **OPNsense metrics:** Not collected
- ❌ **VM/container metrics:** Not time-series tracked

### 7.2 Available Metrics

**PCE Internal Metrics:**
- Query latency (vector/graph/hybrid)
- Ingestion throughput
- Error rates
- API uptime
- Log event counters

**Infrastructure Metrics:**
- ⚠️ **Proxmox:** Current state only (CPU, memory, disk) - not time-series
- ❌ **Network:** Not collected
- ❌ **Storage:** Not collected
- ❌ **Security:** Not collected

### 7.3 Anomaly Detection

**Status:** ❌ **Not Implemented**

**Missing:**
- Time-series anomaly detection
- Threshold-based alerting
- Pattern recognition
- Predictive analytics

---

## 8. EVENTS & HISTORY

### 8.1 Temporal Data Storage

**Current State:**
- ✅ **Document versioning:** SHA-256 hashing, snapshot log
  - Location: `src/pce/dlm/snapshot-log.ts`
  - Tracks: NEW, MODIFIED, UNCHANGED status
- ✅ **Raw document storage:** `.pce/raw-documents/`
  - Location: `src/pce/dlm/storage.ts`
- ✅ **Tool execution audit:** SQLite database
  - Location: `src/pce/api/tool-execution-store.ts`
  - Stores: tool name, parameters, results, user, timestamp, duration
- ✅ **Reasoning traces:** SQLite database
  - Location: `src/pce/api/reasoning-trace-store.ts`
  - Stores: LLM responses, tool calls, RAG context, decisions

**Gaps:**
- ❌ **State history:** No time-series state snapshots
- ❌ **Change diffs:** No structured diff storage
- ❌ **Event log aggregation:** Not implemented

### 8.2 Drift Detection

**Status:** ❌ **Not Implemented**

**Missing:**
- Configuration drift detection
- State comparison over time
- Automated drift alerts
- Remediation suggestions

### 8.3 Change-Driven Triggers

**Status:** ⚠️ **Partially Implemented**

**Current:**
- ✅ Webhook listener exists (`src/pce/realtime/webhook-listener.ts`)
- ✅ Queue consumer for real-time ingestion
- ❌ **Agent triggers:** Not implemented
- ❌ **Auto-remediation:** Not implemented

**Recommendation:**
- Implement change detection rules
- Trigger agent actions on state changes
- Build remediation workflows

---

## 9. PARSER LAYER

### 9.1 Current Parsers

**Proxmox Parsers:**
- ✅ **Normalization:** `src/tools/proxmox/readonly/normalization.ts`
  - Memory units, CPU percentages, human-friendly formats
- ✅ **Graph extraction:** `src/tools/proxmox/readonly/graph-entity-extractor.ts`
  - Extracts PVE_NODE, VM_INSTANCE, PVE_STORAGE
  - Creates relationships: HOSTS_ON, USES, CONNECTED_TO
- ✅ **IP resolution:** `src/tools/proxmox/readonly/ip-resolver.ts`
  - Guest agent → SSH fallback → MAC parsing

**OPNsense Parsers:**
- ✅ **Firewall rules:** `src/tools/opnsense/readonly/opnsense-readonly-tool.ts:711-719`
  - Parses `pfctl` output into structured format
- ✅ **Aliases:** REST API JSON (already structured)

**EDL (Entity Disambiguation Layer):**
- ✅ **LLM extraction:** `src/pce/edl/extraction/extractor.ts`
  - Uses GPT-4o-mini to extract entities/relationships from text
- ✅ **Normalization:** `src/pce/edl/normalization/normalizer.ts`
  - Text normalization, canonical ID generation
- ✅ **Alias mapping:** `src/pce/edl/normalization/alias-mapper.ts`
  - Levenshtein distance matching (0.85 threshold)

**Topology Parser:**
- ✅ **YAML ingestion:** `src/pce/ingestion/topology-ingestion.ts`
  - Extracts networks, hosts, containers, services, dependencies

### 9.2 Parser Coverage by Domain

| Domain | Parser Status | Output Format | Normalization |
|--------|--------------|---------------|---------------|
| **Compute** | ✅ Complete | Typed JSON | ✅ Normalized |
| **Network** | ⚠️ Partial | Typed JSON | ✅ Normalized |
| **Security** | ⚠️ Partial | Text → JSON | ⚠️ Basic |
| **Storage** | ❌ Missing | N/A | N/A |
| **Topology** | ✅ Complete | Typed JSON | ✅ Normalized |
| **Metrics** | ⚠️ Partial | Prometheus | ⚠️ Basic |

### 9.3 Output Normalization Needs

**Well Normalized:**
- ✅ Proxmox responses (memory, CPU, disk units)
- ✅ Topology entities (canonical IDs, normalized names)

**Needs Improvement:**
- ⚠️ Firewall rules (raw `pfctl` output, needs structured parsing)
- ⚠️ Network interfaces (varied formats)
- ⚠️ Storage information (inconsistent units)

**Missing:**
- ❌ ZFS pool status
- ❌ Switch configuration
- ❌ Event logs

---

## 10. SYSTEM MODEL & ONTOLOGY

### 10.1 Canonical State Production

**Current State:**
- ✅ **Proxmox ingestion:** Produces canonical entities (PVE_NODE, VM_INSTANCE, PVE_STORAGE)
- ✅ **Topology ingestion:** Produces canonical entities (Network, VLAN, Host, Service)
- ✅ **EDL pipeline:** Normalizes entities to canonical IDs
- ⚠️ **Tool outputs:** Some produce raw text, not canonical entities

**Gaps:**
- ❌ **All ingested data:** Not all tool outputs produce canonical entities
- ❌ **Namespaces:** No domain-based namespacing
- ❌ **Auto-relationships:** Limited auto-generation

### 10.2 Namespaces

**Status:** ❌ **Not Implemented**

**Current:**
- All entities use flat namespace (canonical IDs like `host:proxbig`)
- No domain separation (compute vs network vs security)

**Recommendation:**
- Implement domain namespaces: `compute:`, `network:`, `security:`, `storage:`
- Update ontology to support namespaced IDs

### 10.3 Auto-Generated Relationships

**Current:**
- ✅ **Proxmox:** Auto-generates HOSTS_ON, USES, CONNECTED_TO
- ✅ **Topology:** Auto-generates CONNECTS_TO, BELONGS_TO, RUNS_ON
- ❌ **Cross-domain:** Limited cross-domain relationship inference

**Recommendation:**
- Implement relationship inference rules
- Cross-reference entities across domains
- Build dependency graphs automatically

### 10.4 State Versioning

**Current:**
- ✅ **Documents:** Versioned via SHA-256 hashes
- ✅ **Graph nodes:** `versionHash` attribute stored
- ❌ **State snapshots:** No time-series state versioning
- ❌ **Historical queries:** Cannot query past state

**Recommendation:**
- Implement temporal graph (Neo4j time-tree or separate versioning)
- Store state snapshots with timestamps
- Enable historical queries

---

## 11. DASHBOARD LAYER

### 11.1 Current Dashboard

**Implementation:**
- ✅ **HTML Dashboard:** `dashboard/index.html`
  - Overview tab: Execution stats, cluster status
  - Tool Executions tab: Real-time execution log
  - Ontology Graph tab: Interactive graph visualization (vis.js)
  - RAG Diagnostics tab: Test queries with chunk scores
  - Auto-refresh every 30 seconds

**API Endpoints:**
- ✅ `/api/dashboard/tool-executions` - Paginated execution log
- ✅ `/api/dashboard/execution-stats` - Execution statistics
- ✅ `/api/dashboard/ontology-graph` - Neo4j graph data
- ✅ `/api/dashboard/rag-diagnostics` - RAG query diagnostics

**Status:** ✅ **Phase 1 Complete** (Hybrid Route)

### 11.2 Topology Visualization

**Current:**
- ✅ Graph visualization using vis.js
- ✅ Interactive node/relationship display
- ⚠️ **Limited:** Basic graph, no filtering/layout options

**Gaps:**
- ❌ Network topology diagrams
- ❌ Physical vs logical view
- ❌ Layer 2/3 visualization
- ❌ Path highlighting

### 11.3 Alerting → Reasoning → Remediation

**Status:** ❌ **Not Implemented**

**Missing:**
- Alert generation from metrics/events
- Alert → RAG reasoning pipeline
- Automated remediation actions
- Remediation approval workflows

**Recommendation:**
- Build alerting rules engine
- Integrate with Hybrid RAG for context
- Implement remediation tool chains
- Add approval gates for high-risk actions

---

## 12. AGENTIC & REASONING

### 12.1 Reasoning Chains

**Current Implementation:**
- ✅ **Hybrid RAG:** `src/pce/rag/hybrid-orchestrator.ts`
  - Query analysis → parallel retrieval (vector + graph) → fusion → generation
  - Supports: SEMANTIC_ONLY, STRUCTURAL_PRIMARY, HYBRID
- ✅ **Tool orchestration:** `src/agent/runner.ts`
  - Single-pass planning, parallel tool execution
  - Context-aware tool selection

**Behavior:**
- **Depth:** Single-pass planning (no multi-step deliberation)
- **Style:** Operational, concise
- **Autonomy:** Tool execution with confirmation for writes

### 12.2 Reasoning Modes

**Current:**
- ✅ **RAG:** Vector + Graph hybrid retrieval
- ✅ **Graph:** Neo4j entity/relationship queries
- ✅ **Hybrid:** Fused semantic + structural context
- ⚠️ **Tool-based:** Available but not always preferred

**Default:** Hybrid RAG (vector + graph)

### 12.3 Auto-Run on Stale Data

**Status:** ⚠️ **Partially Implemented**

**Current:**
- ✅ Cache with 30s TTL for common queries
- ⚠️ **Stale detection:** Not implemented
- ❌ **Auto-refresh:** Not triggered on stale data

**Recommendation:**
- Implement data freshness tracking
- Trigger tool execution when data is stale
- Cache invalidation on state changes

### 12.4 Self-Updating Domains

**Status:** ❌ **Not Implemented**

**Current:**
- Manual ingestion via scripts
- Webhook listener exists but not fully integrated

**Recommendation:**
- Implement scheduled ingestion jobs
- Webhook-driven updates
- Change detection → auto-ingestion

---

## 13. CONSTRAINTS

### 13.1 Performance

**Current Metrics:**
- ✅ **API rate limits:** 10 RPM global, 5 RPM per IP
  - Location: `src/pce/api/rate-limiter.ts`
- ✅ **Query latency:** Tracked and logged
  - Average: ~500ms (well under 15s target)
- ✅ **Concurrent processing:** 10 concurrent webhook events supported

**Acceptable Latency:**
- ⚠️ **Not explicitly defined** - No documented SLA
- Current performance: ~500ms average (good)
- Target (from Phase II): < 15s (exceeded)

**Refresh Frequency:**
- ⚠️ **Not rate-limited** - No documented limits for Proxmox/OPNsense API calls
- Current: Manual ingestion, no automatic polling

**Recommendation:**
- Define SLA: < 5s for queries, < 30s for ingestion
- Implement rate limiting for external API calls
- Add backoff/retry for API failures

### 13.2 Security

**Credentials Storage:**
- ⚠️ **Environment variables:** Used for API keys, passwords
  - `OPENAI_API_KEY`, `NEO4J_PASSWORD`, `QDRANT_API_KEY`
  - No centralized secret management
- ⚠️ **SSH credentials:** Not explicitly documented
- ⚠️ **Proxmox credentials:** Via `ProxmoxClient` (environment-based)

**Token Rotation:**
- ❌ **Not implemented** - No automatic rotation
- ❌ **Expiration tracking:** Not implemented

**Audit Logs:**
- ✅ **Tool execution:** SQLite database with full audit trail
- ✅ **Reasoning traces:** SQLite database with LLM/tool call history
- ✅ **Access control:** ACL groups enforced (admin, ops, viewer)

**Recommendation:**
- Implement secret management (Vault, AWS Secrets Manager)
- Add token expiration/rotation
- Enhance audit logging with security events

---

## 14. GAPS & RECOMMENDATIONS

### 14.1 Critical Gaps

1. **Storage Domain:** No ZFS/volume state collection
2. **Time-Series Metrics:** No historical resource tracking
3. **Event Logs:** No syslog/Suricata integration
4. **Network Topology:** Limited live discovery
5. **State History:** No temporal state versioning
6. **Drift Detection:** Not implemented
7. **Anomaly Detection:** Not implemented

### 14.2 High-Priority Recommendations

1. **Implement Storage Tools:**
   - ZFS pool status parser
   - Volume metadata extraction
   - Snapshot tracking

2. **Add Time-Series Collection:**
   - Integrate Prometheus node exporter
   - Scrape Proxmox metrics
   - Store in time-series DB

3. **Enhance Network Topology:**
   - Live VLAN discovery from OPNsense
   - Switch configuration ingestion
   - Path query implementation

4. **Implement Event Logging:**
   - Syslog collector
   - Suricata log parser
   - Security event correlation

5. **Add Temporal Tracking:**
   - State snapshot storage
   - Historical query support
   - Change diff tracking

### 14.3 Medium-Priority Recommendations

1. **Parser Improvements:**
   - Structured firewall rule parsing
   - Network interface normalization
   - Storage unit standardization

2. **Dashboard Enhancements:**
   - Topology visualization improvements
   - Alerting UI
   - Remediation workflows

3. **Agentic Enhancements:**
   - Auto-refresh on stale data
   - Self-updating domains
   - Change-driven triggers

---

## 15. DELIVERABLES ROADMAP

### 15.1 Canonical Global Ontology Spec

**Status:** ✅ **Partially Complete**

**Current:**
- Ontology defined: `src/pce/kg/schema/ontology.ts`
- Node types: 14 types
- Relationship types: 12 types
- Entity attributes: Defined for all types

**Needed:**
- Domain namespaces
- Temporal attributes
- Extended entity types (Storage, Switch, etc.)

### 15.2 Parser Registry Architecture

**Status:** ⚠️ **Not Formalized**

**Current:**
- Parsers exist but not registered/discoverable
- No parser registry system

**Needed:**
- Parser registry interface
- Auto-discovery of parsers
- Parser versioning

### 15.3 Domain-Specific Parsers

**Status:** ⚠️ **Partial**

**Complete:**
- ✅ Compute (Proxmox)
- ✅ Topology (YAML)
- ⚠️ Network (OPNsense - partial)
- ⚠️ Security (Firewall - basic)

**Missing:**
- ❌ Storage (ZFS)
- ❌ Metrics (Prometheus)
- ❌ Events (Syslog, Suricata)

### 15.4 Digital Twin Ingestion Pipeline

**Status:** ✅ **Operational**

**Current:**
- Proxmox ingestion: `src/pce/ingestion/proxmox-ingestion.ts`
- Topology ingestion: `src/pce/ingestion/topology-ingestion.ts`
- Graph pipeline: `src/pce/ingestion/graph-pipeline.ts`

**Enhancements Needed:**
- Real-time webhook integration
- Change detection triggers
- Cross-domain relationship inference

### 15.5 Interpretation Chain Specification

**Status:** ✅ **Operational**

**Current:**
- EDL pipeline: Extraction → Validation → Normalization → Alias mapping
- Hybrid RAG: Query analysis → Retrieval → Fusion → Generation

**Documentation Needed:**
- Formal specification document
- Flow diagrams
- Error handling specification

### 15.6 Event + Anomaly Pipeline

**Status:** ❌ **Not Implemented**

**Needed:**
- Event collection framework
- Anomaly detection algorithms
- Alert generation
- Remediation workflows

### 15.7 Dashboard + API Spec

**Status:** ✅ **Partially Complete**

**Current:**
- API: REST endpoints documented in code
- Dashboard: HTML implementation exists

**Needed:**
- OpenAPI/Swagger specification
- Dashboard component library
- UX design system

---

## 16. CONCLUSION

Project Palindrome has a **solid foundation** with:
- ✅ Hybrid RAG (vector + graph) operational
- ✅ Multi-domain tooling (Proxmox, OPNsense, SSH)
- ✅ Knowledge graph (Neo4j) with comprehensive ontology
- ✅ Vector store (Qdrant) for semantic search
- ✅ Agentic reasoning with tool orchestration
- ✅ Dashboard and API surface

**Key Strengths:**
- Well-architected PCE with proven scalability
- Comprehensive tool coverage for compute domain
- Strong normalization and entity extraction
- Good provenance tracking

**Critical Gaps:**
- Storage domain (ZFS, volumes, snapshots)
- Time-series metrics and historical state
- Event log collection and correlation
- Network topology live discovery
- Temporal state versioning

**Next Steps:**
1. Implement storage domain tools and parsers
2. Add time-series metric collection
3. Enhance network topology discovery
4. Build event log aggregation
5. Implement temporal state tracking

The platform is **production-ready for compute domain** but needs expansion to achieve full digital-twin coverage across all infrastructure domains.

---

**Report Generated:** 2025-01-27  
**Next Review:** After Phase IV implementation

