# Docker Stack Hardware-Specific Optimizations

## Hardware Configuration
- **CPU**: AMD Ryzen 7 9700X (8 cores, 16 threads, single NUMA node)
- **GPU**: NVIDIA RTX 4070 Ti SUPER (16GB VRAM)
- **RAM**: 32GB total
- **Storage**: Samsung 990 EVO Plus 1TB NVMe (PCIe 4.0)
- **I/O Scheduler**: mq-deadline (optimal for NVMe)

## CPU Pinning Strategy

### Core Allocation
- **Cores 0-1**: Qdrant (vector operations)
- **Cores 2-3**: Neo4j (graph queries)
- **Cores 4-15**: Ollama (LLM inference + token generation)
- **Prometheus/Grafana**: Share available cores (low priority)

This ensures:
- No CPU contention between critical services
- NUMA-aware layout (single NUMA node, all cores accessible)
- Ollama gets maximum CPU for parallel token generation

## Memory Allocation (32GB Total)

| Service | Heap/Cache | Total Limit | Rationale |
|---------|------------|-------------|-----------|
| Qdrant | 2GB mmap cache | 4GB | Vector index caching |
| Neo4j | 4GB heap + 6GB page cache | 12GB | Graph data in memory |
| Ollama | GPU memory (16GB) | No limit | GPU handles model weights |
| Prometheus | 1GB | 1GB | Metrics storage |
| Grafana | 512MB | 512MB | Dashboard rendering |
| **OS + Buffer** | ~14GB | - | System overhead |

## GPU Memory Management (RTX 4070 Ti SUPER - 16GB)

Ollama can fit:
- **1x 13B model** (fully loaded) OR
- **2x 7B models** (partially loaded) OR
- **1x 7B + 1x 3B models**

Configuration:
- `OLLAMA_MAX_LOADED_MODELS=2` - Allow 2 models in GPU memory
- `OLLAMA_KEEP_ALIVE=24h` - Keep models loaded for faster inference
- `OLLAMA_NUM_PARALLEL=4` - Parallel requests (limited by GPU memory)

## Qdrant Optimizations

### Memory-Mapped Files
- **Mmap threshold**: 100,000 vectors (use mmap for large collections)
- **Index cache**: 1GB HNSW index cache
- **Indexing threshold**: 20,000 vectors

### Benefits
- Faster vector search on NVMe (mmap bypasses page cache)
- Reduced memory pressure (OS manages mmap pages)
- Better performance for large collections (>100K vectors)

## Neo4j Optimizations

### Memory Settings
- **Heap**: 4GB (query execution, transaction state)
- **Page cache**: 6GB (graph data cached from NVMe)
- **Total**: 10GB memory usage

### JVM Tuning (AMD Ryzen 7 9700X - Zen 5)
- **G1GC**: Primary garbage collector
- **ZGC**: Experimental (low-latency for graph queries)
- **Max GC pause**: 200ms (acceptable for graph workloads)

### Benefits
- Large page cache = more graph data in RAM
- Faster graph traversals (less NVMe I/O)
- Better query performance for complex traversals

## I/O Scheduling

### Current: mq-deadline (optimal for NVMe)
- Already configured correctly
- No changes needed

### NVMe-Specific Optimizations
- **Prometheus**: WAL compression enabled (reduces write I/O)
- **Neo4j**: Large page cache (reduces read I/O)
- **Qdrant**: Mmap for large collections (bypasses page cache)

## Health Check Timing

All health checks optimized for NVMe low latency:
- **Interval**: 60s (reduced from 90s)
- **Timeout**: 3s (reduced from 5s)
- **Rationale**: NVMe has <1ms latency, 3s is plenty

### Service-Specific
- **Qdrant**: `/ready` endpoint (lightweight, fast)
- **Neo4j**: HTTP `/db/data/` (no JVM overhead)
- **Ollama**: Root endpoint `/` (always responsive)
- **Prometheus/Grafana**: Standard health endpoints

## Performance Expectations

### Expected Improvements
1. **Qdrant**: 20-30% faster vector search (mmap + cache)
2. **Neo4j**: 40-50% faster graph queries (large page cache)
3. **Ollama**: Better GPU utilization (dedicated CPU cores)
4. **Overall**: Lower latency health checks (60s vs 90s)

### Monitoring
- Watch GPU memory usage: `nvidia-smi`
- Monitor CPU pinning: `docker stats`
- Check memory pressure: `free -h`
- I/O wait: `iostat -x 1`

## Troubleshooting

### If Ollama GPU allocation fails:
Uncomment the alternative runtime configuration:
```yaml
runtime: nvidia
environment:
  - NVIDIA_VISIBLE_DEVICES=all
```

### If CPU pinning causes issues:
Remove `cpuset` lines - Docker will auto-balance

### If memory pressure occurs:
Reduce Neo4j page cache from 6GB to 4GB:
```yaml
- NEO4J_dbms_memory_pagecache_size=4G
```

