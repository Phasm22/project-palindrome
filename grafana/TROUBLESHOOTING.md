# Grafana Dashboard Troubleshooting

## Problem: "No data" in dashboard panels

If you're seeing "No data" in most dashboard panels, follow these steps:

### Step 1: Check if PCE API is running and exposing metrics

```bash
# Check if metrics endpoint is accessible
curl http://localhost:4000/metrics

# Or use the diagnostic script
bun run scripts/check-metrics.ts
```

**Expected output:** You should see Prometheus-formatted metrics including:
- `pce_api_uptime_seconds`
- `query_latency_*_ms_avg` (if queries have been made)
- `pce_log_*_total` (if any log counters exist)

### Step 2: Generate test metrics

If no queries have been made, metrics won't exist yet. Generate some test data:

```bash
bun run scripts/generate-test-metrics.ts
```

This will make several test queries to populate metrics.

### Step 3: Check Prometheus is scraping

```bash
# Check Prometheus targets
curl http://localhost:9090/api/v1/targets

# Check Prometheus logs
docker logs prometheus

# Or use the diagnostic script
bun run scripts/check-metrics.ts
```

**What to look for:**
- Target health should be "up"
- Last scrape should be recent (< 30 seconds ago)
- No scrape errors

### Step 4: Verify metrics in Prometheus

```bash
# Query Prometheus directly
curl "http://localhost:9090/api/v1/query?query=pce_api_uptime_seconds"
curl "http://localhost:9090/api/v1/query?query=query_latency_hybrid_ms_avg"
```

### Step 5: Check Grafana datasource

1. Go to Grafana UI: http://localhost:3000
2. Navigate to: Configuration → Data Sources
3. Verify Prometheus datasource is configured and "Test" passes
4. Check the URL is correct: `http://localhost:9090` (or `http://host.docker.internal:9090` if not using host network)

### Step 6: Check Prometheus logs

```bash
# View Prometheus container logs
docker logs prometheus --tail 100

# Look for:
# - Scrape errors
# - Connection refused errors
# - Target status changes
```

### Step 7: Check Grafana logs

```bash
# View Grafana container logs
docker logs grafana --tail 100

# Look for:
# - Datasource connection errors
# - Query errors
# - Dashboard loading issues
```

## Common Issues

### Issue: Prometheus can't reach PCE API

**Symptoms:**
- Prometheus targets show "down"
- Logs show "connection refused"

**Solutions:**
1. Verify PCE API is running: `curl http://localhost:4000/health`
2. Check network mode in docker-compose.yml (should be `network_mode: host` for Prometheus)
3. If using Docker network, ensure `extra_hosts` includes `host.docker.internal:host-gateway`

### Issue: Metrics exist but dashboard shows "No data"

**Symptoms:**
- Metrics visible in Prometheus UI
- Dashboard panels show "No data"

**Solutions:**
1. Check metric names match exactly (case-sensitive)
2. Verify time range in dashboard (try "Last 5 minutes")
3. Check if metrics have recent timestamps (within last hour)
4. Refresh dashboard (Ctrl+R or browser refresh)

### Issue: Only uptime metric shows data

**Symptoms:**
- `pce_api_uptime_seconds` works
- All query metrics show "No data"

**Cause:** No queries have been made yet.

**Solution:**
```bash
# Generate test queries
bun run scripts/generate-test-metrics.ts

# Wait 15-30 seconds for Prometheus to scrape
# Then refresh Grafana dashboard
```

### Issue: Error rate panel shows "No data"

**Expected:** Error rate will only show data if errors have occurred. This is normal if the system is healthy.

**To test:** The panel will populate if you trigger an error (e.g., invalid query, service unavailable).

## Quick Diagnostic Commands

```bash
# Full diagnostic check
bun run scripts/check-metrics.ts

# Generate test data
bun run scripts/generate-test-metrics.ts

# Check Prometheus targets
curl http://localhost:9090/api/v1/targets | jq

# Check specific metric
curl "http://localhost:9090/api/v1/query?query=pce_api_uptime_seconds" | jq

# View Prometheus logs
docker logs prometheus --tail 50 -f

# View Grafana logs  
docker logs grafana --tail 50 -f
```

## Metric Naming

Metrics are exported with these suffixes:
- `_avg` - Average value
- `_count` - Count of samples (use with `rate()` for per-second)
- `_min` - Minimum value
- `_max` - Maximum value
- `_latest` - Latest value

Example:
- `query_latency_hybrid_ms_avg` - Average hybrid query latency
- `query_latency_hybrid_ms_count` - Total count (use `rate(query_latency_hybrid_ms_count[1m])` for queries/sec)

## Still Having Issues?

1. Check all services are running:
   ```bash
   docker ps | grep -E "prometheus|grafana|pce"
   ```

2. Verify network connectivity:
   ```bash
   # From Prometheus container
   docker exec prometheus curl http://localhost:4000/metrics
   ```

3. Check Prometheus configuration:
   ```bash
   cat prometheus/prometheus.yml
   ```

4. Verify dashboard JSON is valid:
   ```bash
   cat grafana/provisioning/dashboards/maybeDashboard.json | jq .
   ```

