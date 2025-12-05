# Local GPU Setup - Sovereign AI Control Plane

## Philosophy

**Goal:** Build a sovereign, inspectable, failure-tolerant AI control plane that happens to be cheap.

**Principles:**
- **Sovereignty:** No vendor lock-in, full control over models and data
- **Inspectability:** Can see exactly what's happening, debug easily
- **Failure Tolerance:** Graceful degradation, automatic fallbacks
- **Simplicity:** Solo operator-friendly, avoid over-engineering
- **Cost:** Nice side effect, not the primary goal

## Current Status ✅

**Hardware:** RTX 4070 Ti SUPER (16GB VRAM) - Currently using ~5% (820MB/16GB)
**Models Installed:**
- `nomic-embed-text` (274MB) - Embeddings, 768 dimensions
- `mistral:7b` (4.4GB) - RAG generation
- `llama3.1:8b` (4.9GB) - Entity extraction, instruction following

**Ollama:** Running in Docker with GPU support
**Configuration:** ✅ Local models enabled (`EMBEDDINGS_PROVIDER=local`, `LLM_PROVIDER=local`)

## Simple Model Strategy (Solo Operator)

**Keep it simple:** One model per task, automatic fallbacks.

### Current Setup (Works Well)

1. **Embeddings** → `nomic-embed-text` (274MB)
   - Always available, fast
   - Falls back to OpenAI if Ollama down

2. **RAG Generation** → `mistral:7b` (4.4GB)
   - Good quality, handles most queries
   - Falls back to OpenAI if needed

3. **Entity Extraction** → `llama3.1:8b` (4.9GB)
   - Use when needed, or fallback to OpenAI

**Total GPU Usage:** ~9.5GB when all loaded (leaves 6.5GB for host)

**Failure Tolerance:** All services have automatic OpenAI fallback - system keeps working even if Ollama fails.

## Recommended Setup

### 1. Ollama is Already Running

```bash
docker compose up -d ollama
```

### 2. Pull Additional Models (Optional)

```bash
# For better tool calling (recommended)
docker exec ollama ollama pull qwen2.5:7b

# For faster embeddings (alternative)
docker exec ollama ollama pull bge-base-en-v1.5  # 768 dim, better quality
```

## Configuration (Simple & Reliable)

### Docker Config (Current - Good Balance)

```yaml
environment:
  - OLLAMA_MAX_LOADED_MODELS=3   # Keep 3 models warm
  - OLLAMA_KEEP_ALIVE=24h        # Keep models loaded (faster responses)
  - OLLAMA_NUM_PARALLEL=4        # Handle 4 requests at once
  - OLLAMA_FLASH_ATTENTION=1     # Memory optimization
```

**Why this works:**
- Models stay loaded = faster responses
- Leaves plenty of GPU for host use
- Automatic fallback to OpenAI if Ollama fails

### Environment Variables

Add to `.env`:

```bash
# Use local models
EMBEDDINGS_PROVIDER=local
LOCAL_EMBED_MODEL=nomic-embed-text

# RAG generation
LLM_PROVIDER=local
LOCAL_LLM_MODEL=mistral:7b

# Entity extraction (if implemented)
ENTITY_EXTRACTION_MODEL=llama3.1:8b

# Agent reasoning (future)
AGENT_MODEL=qwen2.5:7b

OLLAMA_BASE_URL=http://localhost:11434
```

## Failure Tolerance & Inspectability

### Current Implementation

✅ **Embeddings:** Local with OpenAI fallback (`EmbeddingService`)  
✅ **RAG Generation:** Local with OpenAI fallback (`GenerationService`)  
✅ **Agent Reasoning:** OpenAI (reliable, good tool calling)

**How it works:**
- Try local first (fast, free, inspectable)
- Fallback to OpenAI if local fails (reliable, always works)
- All failures are logged and visible

**Inspectability:**
- Check Ollama: `docker logs ollama`
- Check GPU: `nvidia-smi`
- Check models: `docker exec ollama ollama ps`
- All requests logged in PCE API logs

## GPU Memory Management

**Current:** ~820MB used (5% of 16GB)  
**With 3 models loaded:** ~9.5GB (59% of 16GB)  
**Headroom:** ~6.5GB for host use + overhead ✅

**To keep host responsive:**
- Limit `OLLAMA_NUM_PARALLEL=4` (current)
- Use CPU pinning (already configured: cores 4-15)
- Monitor with: `nvidia-smi`

## What's Working (Keep It Simple)

### ✅ Core Services (DONE)
- **Embeddings:** Local with OpenAI fallback
- **RAG Generation:** Local with OpenAI fallback
- **Agent Reasoning:** OpenAI (reliable, good tool calling)

**Why this works:**
- Most queries use local (fast, inspectable, free)
- Complex queries use OpenAI (reliable, proven)
- System never breaks (automatic fallbacks)
- Easy to debug (all logs visible)

### Optional Enhancements (Only If Needed)

**Entity Extraction:** Could use local, but OpenAI works fine for now
- **When to add:** If you're doing high-volume extraction and want to inspect it
- **Otherwise:** Keep using OpenAI, it's reliable

**Agent Reasoning:** Could use local, but OpenAI is better for tool calling
- **When to add:** If you want full sovereignty and don't mind occasional failures
- **Otherwise:** Keep using OpenAI for agent, it's more reliable

## Benefits (Beyond Cost)

**Sovereignty:**
- Your data never leaves your machine (embeddings, RAG)
- Can inspect exactly what models are doing
- No vendor lock-in, can switch anytime

**Inspectability:**
- See all model inputs/outputs in logs
- Debug failures easily (local logs vs API black box)
- Understand what the system is actually doing

**Failure Tolerance:**
- Ollama down? Falls back to OpenAI automatically
- Model fails? Falls back gracefully
- System keeps working even when components fail

**Cost (Nice Side Effect):**
- Embeddings: Free (vs $0.02/1M tokens)
- RAG: Free (vs $0.15/1M tokens)
- **Savings:** Negligible at current scale (~$0.49/month actual OpenAI usage)
- **Meaningful savings:** Only under sustained multi-million-token daily workloads
- **But that's not why we do this** - sovereignty and inspectability are the real goals

## Quick Start

✅ **Already configured!** Local models are enabled with automatic fallbacks.

**To verify everything works:**

1. **Check Ollama is running:**
   ```bash
   docker ps | grep ollama
   docker logs ollama --tail 20
   ```

2. **Test local models:**
   ```bash
   # Test embeddings (should use local)
   curl http://localhost:4000/api/query -d '{"query": "test"}'
   
   # Check logs to see if local or OpenAI was used
   ```

3. **Monitor system health:**
   ```bash
   # GPU usage
   nvidia-smi
   
   # Ollama models loaded
   docker exec ollama ollama ps
   
   # System logs
   docker logs ollama --tail 50
   ```

## Maintenance (Solo Operator Friendly)

**Daily:** Nothing needed - system runs itself

**Weekly:** Check logs if something seems off
```bash
docker logs ollama --tail 100 | grep -i error
```

**Monthly:** Update models if needed
```bash
docker exec ollama ollama pull mistral:7b  # Gets latest version
```

**If something breaks:**
1. Check Ollama: `docker logs ollama`
2. System falls back to OpenAI automatically
3. Fix when convenient, no urgency
