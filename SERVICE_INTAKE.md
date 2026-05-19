# Service Intake Flow

Generated: 2026-05-19

Scope: Project Palindrome runtime services and recurring jobs that can feed the service registry and log contract. This intake is based on `package.json`, `docker-compose.yml`, `scripts/start-all.ts`, `scripts/palindrome-services.service`, `src/pce/api/server.ts`, `src/pce/scheduler/ingestion-scheduler.ts`, `dashboard/serve.ts`, `prometheus/prometheus.yml`, and live local checks.

Live evidence gathered:
- `docker compose config --services`: `ollama`, `prometheus`, `qdrant`, `clear-vector-store`, `grafana`, `neo4j`.
- `docker compose ps`: `qdrant`, `neo4j`, `ollama`, `prometheus`, and `grafana` are up and Docker-healthy.
- `systemctl is-active palindrome-services`: `active`.
- `curl -fsSI http://localhost:8080/`: `200 OK`.
- `curl -fsS http://localhost:4000/health`, `/metrics?format=prometheus`, and `/api/dashboard/ingestion-status`: connection refused.
- `journalctl -u palindrome-services`: PCE API child failed with `Failed to start server. Is port 4000 in use?`; the parent still printed "All services started."

Operational context: the stack/Compose state may intentionally be down or partially displaced during development because additional services are being worked on. Treat the live checks above as a snapshot for shaping health contracts, not as evidence of an incident. The durable monitoring lesson is that parent/supervisor state, child process state, and externally observable health must be tracked separately.

## Stage 1 Gate

| Candidate | Gate Result | Trigger Defined | Observable Success | Structured Output Possible | Silence Window Stated | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `palindrome-services` systemd supervisor | Pass, with caveat | Continuous systemd unit | Unit active plus child process/API/dashboard/container checks | Yes, via journal plus child logs | 2 minutes without a supervisor heartbeat/status sample | Unit-active alone is insufficient. |
| PCE API server | Pass | Continuous child process from `scripts/start-all.ts` or `bun run pce:api` | `GET /health` returns success and `/metrics` exports samples | Yes, PCE logger emits timestamped level plus JSON metadata | 2 minutes without successful `/health` or metrics scrape | May intentionally be down during development. |
| PCE ingestion scheduler | Pass, only when PCE API is running | `setInterval` every 5 minutes, immediate first run | `/api/dashboard/ingestion-status` shows recent successful run | Yes, scheduler logs JSON metadata and records metrics | Warning at 7 minutes since last run, alert at 10 minutes | Only monitor as active when the PCE API service is intended to be running. |
| Dashboard server | Pass | Continuous child process from `scripts/start-all.ts` or `bun run dashboard:serve` | `GET /` returns `200 OK` HTML | Small patch needed for structured logs; current logs are plain stdout | 2 minutes without successful HTTP probe | Static dashboard health is separate from API proxy health. |
| Qdrant | Pass | Continuous Docker Compose service | Docker healthcheck passes and REST port `6333` responds | Yes, Docker logs plus health status; app can also query `/collections` | 2 missed 60-second healthchecks | Monitor only when Compose dependencies are in the intended-up profile. |
| Neo4j | Pass | Continuous Docker Compose service | Docker healthcheck passes and HTTP/Bolt ports respond | Yes, Docker logs and Neo4j logs volume | 3 missed 60-second healthchecks | Monitor only when Compose dependencies are in the intended-up profile. |
| Ollama | Pass | Continuous Docker Compose service | Docker healthcheck `ollama list` passes | Yes, Docker logs; model-level output needs app metrics | 2 missed 60-second healthchecks | Monitor only when local model service is in the intended-up profile. |
| Prometheus | Pass | Continuous Docker Compose service plus 15-second scrape loop | `/-/healthy` passes and `pce-api` target is up | Yes, Docker logs, target health, TSDB metrics | 1 minute without scrape data; alert at 2 minutes | Target-down is actionable only when PCE API is intended to be up. |
| Grafana | Pass | Continuous Docker Compose service | `/api/health` passes and dashboards provision | Yes, Docker logs and Grafana provisioning logs | 2 missed 60-second healthchecks | Monitor only when observability profile is intended to be up. |
| `clear-vector-store` | Deferred | One-shot manual Compose run | Success can be observed, but it is destructive maintenance | Yes | Not applicable | Do not monitor as a standing service. |
| Manual ingestion scripts (`pce:ingest-*`) | Deferred | Manual CLI, optional cron documented but not proven installed | Success observable in process exit/logs | Yes | Not defined unless cron/systemd timer exists | Monitor the API scheduler instead unless a real cron/timer is installed. |
| Diagnostics (`metrics:check`, `grafana:verify-dashboard`, gold path/provenance audits) | Deferred | Manual validation commands | Success is clean exit | Yes | Not applicable | Treat as runbook checks, not services. |
| Dashboard build/Tailwind build | Deferred | Manual build command | Success is clean exit and CSS artifact | Yes | Not applicable | Build job, not runtime monitoring. |
| Agent CLI / REPL | Deferred | Operator-invoked | Success is command response | Could log structured output with a small patch | Not applicable | Interactive command surface, not a service. |

## Stage 2 Questionnaire

### `palindrome-services` Systemd Supervisor

Identity: Starts and holds the Palindrome runtime stack: Docker Compose dependencies, PCE API, and dashboard.

Trigger: Continuous systemd service: `ExecStart=/home/tj/.bun/bin/bun run scripts/start-all.ts`, with `Restart=always`.

Execution:
- Expected frequency or silence window: Always running; poll status every minute. Maximum acceptable silence is 2 minutes without a status sample.
- Expected max run duration before hung: Startup should reach "All services started" within 3 minutes because Qdrant/Neo4j readiness waits are 60 seconds each plus child startup.

Health:
- Success: systemd unit is active, PID file points at a live `start-all.ts` process, Docker services are healthy, dashboard responds, and PCE API `/health` responds.
- Can fail silently and still appear to have run: Yes. A supervisor can be active while a child process is intentionally stopped, displaced, or crashed.
- Outside failure: inactive/failed unit, stale PID, missing child process, child HTTP checks failing, or recent journal error after a successful parent startup message.

Alerting:
- One failure or consecutive: Alert on two consecutive failed full-stack checks; page immediately if unit is failed.
- Missed window: Warning at 2 minutes without a status sample; alert at 5 minutes.
- Downstream impact: Yes. If this fails, the API, dashboard, ingestion, Prometheus target, and local automation surface are unreliable.

Logging current state:
- Logs: `journalctl -u palindrome-services`, plus `logs/palindrome-api.log` and `logs/dashboard.log`.
- Format: Journal lines are mostly prefixed child stdout; PCE child lines are semi-structured with JSON metadata. Dashboard logs are plain text.
- Tells what happened or just that it ran: It tells child startup/failure, but the parent can still declare success when a child exits.
- Current break detection: Manual `systemctl`, `journalctl`, `docker compose ps`, and HTTP probes.

Dashboard:
- At a glance: Parent status plus child health count, especially "API child missing while supervisor active."

### PCE API Server

Identity: Serves Palindrome query, agent, dashboard, health, metrics, history, profile, and ingestion-status endpoints.

Trigger: Continuous process via `bun run src/pce/api/main.ts`, usually started by `scripts/start-all.ts` or `bun run pce:api`.

Execution:
- Expected frequency or silence window: Always available. Prometheus scrapes every 15 seconds; maximum acceptable scrape silence is 2 minutes.
- Expected max run duration before hung: HTTP requests should complete under the Bun idle timeout of 255 seconds; `/health` and `/metrics` should complete in under 5 seconds.

Health:
- Success: `GET /health` returns success, dependency checks are healthy, `/metrics?format=prometheus` includes samples such as `pce_api_uptime_seconds`, and the process remains alive.
- Can fail silently and still appear to have run: Yes, if only the systemd parent is monitored. Also possible if `/health` is degraded but process is alive.
- Outside failure: port `4000` not listening, `/health` non-2xx/503, `/metrics` empty/missing required metrics, high error counters, or repeated startup bind errors.

Alerting:
- One failure or consecutive: Alert after two consecutive failed health probes or failed Prometheus scrapes; alert immediately on process exit in child logs.
- Missed window: Warning at 1 minute without successful metrics; alert at 2 minutes.
- Downstream impact: Yes. Dashboard API proxy, Prometheus `pce-api` target, agent queries, and ingestion scheduler depend on it.

Logging current state:
- Logs: `logs/palindrome-api.log` when started by `start-all.ts`; journal also captures prefixed lines.
- Format: `[timestamp] [LEVEL] message {json}` for PCE logger; some shared utility logs use `[info] message {json}`.
- Tells what happened or just that it ran: Generally tells what happened, including dependency initialization, ingestion starts/completions, and startup failures.
- Current break detection: `curl http://localhost:4000/health`, Prometheus target health, `logs/palindrome-api.log`, and journal.

Dashboard:
- At a glance: API status, uptime, dependency health, last successful metrics scrape, and the most recent fatal error.

### PCE Ingestion Scheduler

Identity: Refreshes the digital twin and vector/graph stores by running Proxmox, network, firewall ingestion, then stale-node cleanup.

Trigger: In-process scheduler started by the PCE API; runs immediately at API startup and then every 5 minutes.

Execution:
- Expected frequency or silence window: One run every 5 minutes. Warning if no completed run after 7 minutes; alert after 10 minutes.
- Expected max run duration before hung: 4 minutes. Live historical log showed a successful full run at about 140 seconds, so 4 minutes leaves headroom without hiding hangs.

Health:
- Success: `lastRunDetails.success === true`, Proxmox/network/firewall component successes are true, cleanup completes or only emits non-fatal warnings, and scheduler metrics increment.
- Can fail silently and still appear to have run: Yes. Individual component failures are captured while the scheduler process remains alive; cleanup failures are explicitly non-fatal.
- Outside failure: stale `lastRun`, rising failure count, repeated "Ingestion already running, skipping this cycle", missing component success metrics, or no `/api/dashboard/ingestion-status`.

Alerting:
- One failure or consecutive: Alert on two consecutive failed runs; warning on a single component failure.
- Missed window: Warning at 7 minutes, alert at 10 minutes since last completion.
- Downstream impact: Yes. Query freshness, temperature data, stale-node cleanup, and dashboard graph accuracy degrade.

Logging current state:
- Logs: `logs/palindrome-api.log` and journal.
- Format: Structured PCE logger plus metrics names like `ingestion_scheduler_run_success`, `ingestion_scheduler_run_duration_ms`, and component duration/success counters.
- Tells what happened or just that it ran: It tells component start/completion, durations, errors, cleanup deletes, and final success.
- Current break detection: `/api/dashboard/ingestion-status`, `/metrics`, and PCE API logs. If the PCE API is intentionally down, suppress scheduler silence alerts.

Dashboard:
- At a glance: Last run age, last run status, component statuses, duration, and cleanup deletes.

### Dashboard Server

Identity: Serves the Palindrome web dashboard, static assets, live reload websocket, and proxies API paths to the PCE API.

Trigger: Continuous process via `bun run dashboard/serve.ts`, usually started by `scripts/start-all.ts` or `bun run dashboard:serve`.

Execution:
- Expected frequency or silence window: Always available on HTTP `8080`; HTTPS `8443` when certs exist. Maximum acceptable silence is 2 minutes without successful HTTP probe.
- Expected max run duration before hung: Static `GET /` should complete in under 5 seconds; proxied API paths should follow PCE API expectations.

Health:
- Success: `GET /` returns `200 OK` and content type `text/html`; API proxy paths work when PCE API is healthy.
- Can fail silently and still appear to have run: Partially. It can serve static HTML while API proxy calls fail because PCE API is down.
- Outside failure: port `8080` not listening, non-2xx on `/`, websocket errors rising, or `/api/health` proxy failing while static root still works.

Alerting:
- One failure or consecutive: Alert on two consecutive root probe failures; warning when static root works but `/api/health` fails.
- Missed window: Warning at 2 minutes without root probe success; alert at 5 minutes.
- Downstream impact: It does not break ingestion or API directly, but breaks operator visibility and browser-based control.

Logging current state:
- Logs: `logs/dashboard.log` and journal.
- Format: Plain stdout messages and websocket connect/disconnect lines; structured logging would require a small patch.
- Tells what happened or just that it ran: Mostly tells startup and websocket churn, not request outcome or proxy health.
- Current break detection: `curl -I http://localhost:8080/`, browser behavior, and logs.

Dashboard:
- At a glance: Static server status plus API proxy status, shown separately.

### Qdrant

Identity: Vector database for PCE document chunks and semantic retrieval.

Trigger: Continuous Docker Compose service `qdrant`.

Execution:
- Expected frequency or silence window: Always running. Docker healthcheck interval is 60 seconds; maximum acceptable silence is 2 missed healthchecks.
- Expected max run duration before hung: Healthcheck should complete within 5 seconds after startup; startup grace is 10 seconds.

Health:
- Success: Docker health is healthy and REST API on `6333` responds; expected collections are present when PCE is initialized.
- Can fail silently and still appear to have run: Yes, a process-level healthcheck can pass while a collection is missing or query/index operations fail.
- Outside failure: unhealthy container, port unavailable, missing `pce_documents` collection, failed vector upsert/search, or storage volume errors.

Alerting:
- One failure or consecutive: Alert after two consecutive unhealthy checks; warning on missing expected collection.
- Missed window: Alert after 2 minutes without health/sample data.
- Downstream impact: Yes. Semantic retrieval and ingestion vector writes fail or degrade.

Logging current state:
- Logs: `docker logs qdrant`; data in `qdrant_storage` volume.
- Format: Container stdout/stderr, service-specific.
- Tells what happened or just that it ran: Usually operational enough for startup/storage/API issues; app-level collection failures also appear in PCE logs.
- Current break detection: `docker compose ps`, REST probe, and PCE API dependency checks.

Dashboard:
- At a glance: Container health, REST availability, collection count, and last PCE vector write/search error.

### Neo4j

Identity: Graph database for the digital twin and relationship queries.

Trigger: Continuous Docker Compose service `neo4j`.

Execution:
- Expected frequency or silence window: Always running. Docker healthcheck interval is 60 seconds; maximum acceptable silence is 3 missed healthchecks.
- Expected max run duration before hung: Healthcheck should complete within 3 seconds after the 30-second startup period; graph queries should have separate query-level latency thresholds.

Health:
- Success: Docker health is healthy, HTTP `7474` responds, Bolt `7687` accepts connections, and graph queries succeed.
- Can fail silently and still appear to have run: Yes, HTTP can be up while Bolt/auth/query performance is broken.
- Outside failure: unhealthy container, Bolt connection failure, auth failure, excessive query latency, or write failures during ingestion.

Alerting:
- One failure or consecutive: Alert after two consecutive Bolt/HTTP failures; warning on slow query or ingestion write errors.
- Missed window: Alert after 3 minutes without health/sample data.
- Downstream impact: Yes. Twin-backed queries, ingestion graph writes, stale cleanup, and dashboard graph views degrade.

Logging current state:
- Logs: `docker logs neo4j` and `neo4j_logs` volume.
- Format: Neo4j service logs.
- Tells what happened or just that it ran: Good for database lifecycle; app-level graph errors appear in PCE logs.
- Current break detection: `docker compose ps`, HTTP/Bolt probes, and PCE dependency checks.

Dashboard:
- At a glance: Container health, Bolt connectivity, node/relationship write success, and latest graph query error.

### Ollama

Identity: Local LLM/embedding runtime for local model-backed generation or embeddings.

Trigger: Continuous Docker Compose service `ollama`.

Execution:
- Expected frequency or silence window: Always running. Docker healthcheck interval is 60 seconds; maximum acceptable silence is 2 missed healthchecks.
- Expected max run duration before hung: `ollama list` should complete within 10 seconds; model inference needs model-specific latency thresholds.

Health:
- Success: Docker health is healthy and `ollama list` responds; required models are installed and callable when the app is configured for local use.
- Can fail silently and still appear to have run: Yes, the daemon can be healthy while a required model is absent or GPU acceleration is unavailable.
- Outside failure: unhealthy container, missing model, inference timeout, GPU/runtime errors, or mapped port `11435` unavailable.

Alerting:
- One failure or consecutive: Alert after two consecutive daemon health failures; warning on missing model.
- Missed window: Alert after 2 minutes without daemon health data.
- Downstream impact: Conditional. It breaks local embeddings/LLM paths when selected, but OpenAI-backed paths may continue.

Logging current state:
- Logs: `docker logs ollama`.
- Format: Container stdout/stderr.
- Tells what happened or just that it ran: Tells daemon/model load errors; application failures also appear in PCE logs.
- Current break detection: `docker compose ps ollama`, `docker exec ollama ollama list`, and app embedding/generation errors.

Dashboard:
- At a glance: Daemon health, required model presence, and last inference/embedding error.

### Prometheus

Identity: Scrapes PCE API metrics and stores time-series data for Grafana dashboards.

Trigger: Continuous Docker Compose service `prometheus`; scrape loop every 15 seconds from `prometheus/prometheus.yml`.

Execution:
- Expected frequency or silence window: Scrapes `localhost:4000/metrics?format=prometheus` every 15 seconds. Warning after 1 minute without `pce-api` samples; alert after 2 minutes.
- Expected max run duration before hung: Health endpoint should complete under 3 seconds; scrape timeout is 10 seconds.

Health:
- Success: `/-/healthy` is healthy, Prometheus target `job="pce-api"` is up, and required PCE metrics are present.
- Can fail silently and still appear to have run: Yes, Prometheus can be healthy while the PCE target is down.
- Outside failure: target health down, no recent samples, bad Prometheus config, TSDB/storage errors, or missing required metrics.

Alerting:
- One failure or consecutive: Warning on one failed target scrape; alert on 2 minutes of target down or missing core samples.
- Missed window: Alert after 2 minutes without PCE metric samples.
- Downstream impact: Yes for observability. It does not stop PCE, but dashboards and alerts lose data.

Logging current state:
- Logs: `docker logs prometheus`; target state via `/api/v1/targets`.
- Format: Prometheus logs plus metrics API JSON.
- Tells what happened or just that it ran: Target health tells what scrape is failing; logs explain config/storage issues.
- Current break detection: `bun run metrics:check`, Prometheus targets API, and Grafana panels. Target-down should page only when the target service is in the intended-up set.

Dashboard:
- At a glance: `pce-api` scrape target health and age of latest `pce_api_uptime_seconds` sample.

### Grafana

Identity: Presents Palindrome/PCE metrics dashboards backed by Prometheus.

Trigger: Continuous Docker Compose service `grafana`.

Execution:
- Expected frequency or silence window: Always running. Docker healthcheck interval is 60 seconds; maximum acceptable silence is 2 missed healthchecks.
- Expected max run duration before hung: `/api/health` should complete within 3 seconds after the 10-second startup period.

Health:
- Success: Grafana `/api/health` passes, Prometheus datasource is provisioned, and dashboard PromQL queries execute.
- Can fail silently and still appear to have run: Yes, Grafana can be healthy while datasource queries fail or dashboards have no data.
- Outside failure: unhealthy container, bad datasource, dashboard provisioning errors, authentication/config errors, or PromQL verification failure.

Alerting:
- One failure or consecutive: Alert after two consecutive Grafana health failures; warning on datasource/dashboard query failures.
- Missed window: Alert after 2 minutes without Grafana health data.
- Downstream impact: Operator visibility breaks, but PCE runtime continues.

Logging current state:
- Logs: `docker logs grafana`; provisioning uses `grafana/provisioning`.
- Format: Grafana service logs.
- Tells what happened or just that it ran: Good for provisioning/datasource/server lifecycle, but no app-specific meaning.
- Current break detection: Docker health, `/api/health`, and `bun run grafana:verify-dashboard`.

Dashboard:
- At a glance: Grafana health, datasource health, and number of panels with failing/no-data queries.

## Registry And Log Contract Recommendations

Required registry fields for passers:
- `service_id`
- `type`: `systemd`, `process`, `scheduled_job`, or `docker`
- `trigger`
- `health_probe`
- `success_condition`
- `max_silence_seconds`
- `max_duration_seconds`
- `alert_policy`
- `downstream_impact`
- `log_sources`
- `structured_log_status`
- `dashboard_primary_signal`

Minimum log event names to standardize:
- `service.starting`
- `service.ready`
- `service.unhealthy`
- `service.exited`
- `health.probe`
- `job.started`
- `job.completed`
- `job.failed`
- `job.skipped`

Immediate monitoring risks to fix before building alerts:
- `scripts/start-all.ts` does not fail or restart when the PCE API child exits during startup; monitoring must not treat the parent process as sufficient.
- Dashboard lacks its own health endpoint and structured request/proxy logs.
- Prometheus can be healthy while the `pce-api` scrape target is down; alert on target health, not just container health.
- Manual ingestion scripts should stay deferred unless an actual cron/systemd timer is installed and discoverable.
