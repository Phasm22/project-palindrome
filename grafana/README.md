# Grafana Configuration for Palindrome PCE

This directory contains Grafana provisioning configuration for monitoring Palindrome PCE metrics.

## Setup

### Option 1: Using Docker Compose (Recommended)

Grafana and Prometheus are already configured in `docker-compose.yml`:

```bash
# Start all services including Grafana and Prometheus
docker compose up -d grafana prometheus

# Or start everything
docker compose up -d
```

This will start:
- **Grafana** on http://localhost:3000 (admin/admin)
- **Prometheus** on http://localhost:9090 (optional, for intermediate aggregation)

### Option 2: Manual Docker Setup

```bash
# Start Grafana
docker run -d \
  --name=grafana \
  -p 3000:3000 \
  -v $(pwd)/grafana/provisioning:/etc/grafana/provisioning \
  -v $(pwd)/grafana/dashboards:/var/lib/grafana/dashboards \
  grafana/grafana:latest

# Start Prometheus (optional)
docker run -d \
  --name=prometheus \
  -p 9090:9090 \
  -v $(pwd)/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml \
  prom/prometheus:latest
```

### 3. Configure Grafana Data Source

The data source is **automatically provisioned** from `grafana/provisioning/datasources/prometheus.yml`.

**Current default:**
- Grafana uses Prometheus as the only datasource
- Datasource URL: `http://localhost:9090` (host network mode)
- Prometheus scrapes PCE API from `http://localhost:4000/metrics?format=prometheus`

### 4. Access Dashboards

1. Open Grafana: http://localhost:3000
2. Default credentials: `admin` / `admin`
3. Navigate to Dashboards → Palindrome → PCE Overview

## Architecture

**Recommended Setup: Prometheus as Intermediate**

```
PCE API (host:4000) 
  → /metrics?format=prometheus (raw metrics)
    ↓ (scraped by)
Prometheus (container:9090)
  → /api/v1/query (Prometheus Query API)
    ↓ (queried by)
Grafana (container:3000)
  → Dashboards and visualizations
```

**Why Prometheus as Intermediate?**
- Grafana's Prometheus datasource requires Prometheus Query API (`/api/v1/query`)
- PCE API only provides raw metrics (`/metrics`), not query API
- Prometheus scrapes, stores, and provides query capabilities
- Better for time-series data retention and aggregation

## Direct PCE API Connection (Alternative)

If you want to connect Grafana directly to PCE API (without Prometheus), you would need:
- A custom Grafana plugin/datasource (not supported out of the box)
- Or modify PCE API to provide Prometheus Query API (complex)

**Recommended:** Use Prometheus as configured.

## Available Metrics

The PCE API exposes the following metrics in Prometheus format:

- `query_latency_*_ms_avg` - Average query latency by type (vector/graph/hybrid)
- `query_latency_*_ms_count` - Query count by type
- `ingestion_throughput_*_per_min_avg` - Ingestion throughput
- `ingestion_latency_*_ms_avg` - Ingestion latency
- `pce_api_uptime_seconds` - API server uptime
- `api_http_requests_total_count` - API request volume
- `api_http_request_duration_ms_avg` - API request latency
- `pce_metrics_series_count` - Number of exported series
- `pce_process_*` - API process CPU and memory
- `pce_log_*_total` - Log event counters

## Custom Dashboards

Create custom dashboards in `grafana/dashboards/` and they will be automatically provisioned.

## Verification

Run both checks after services are up:

```bash
bun run metrics:check
bun run grafana:verify-dashboard
```
