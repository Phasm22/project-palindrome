# Local GPU Setup for 4070Ti

## Overview

With your 4070Ti (16GB VRAM), you can run:
- ✅ **Local Embeddings** - Much faster, no API costs, perfect for high-volume ingestion
- ✅ **Local LLMs** - For RAG generation, entity extraction, and potentially agent reasoning
- ⚠️ **Hybrid Approach** - Keep OpenAI for complex tool calling, use local for everything else

## Recommended Setup: Ollama

Ollama is the easiest way to run local models with OpenAI-compatible API.

### 1. Install Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

### 2. Pull Models

```bash
# For embeddings (384 dimensions - compatible with many models)
ollama pull bge-small-en-v1.5

# For LLM inference (good for RAG generation)
ollama pull llama3.2:3b        # Fast, good for simple tasks
ollama pull llama3.1:8b        # Better quality, still fits in 16GB
ollama pull mistral:7b         # Excellent for RAG
ollama pull qwen2.5:7b         # Great tool calling support

# For embeddings with 1536 dimensions (matching OpenAI)
ollama pull nomic-embed-text   # 768 dim, but very good
# Or use sentence-transformers directly
```

### 3. Start Ollama Service

```bash
ollama serve
# Runs on http://localhost:11434
```

## Alternative: Direct Model Serving

### Option A: vLLM (Fastest inference)

```bash
pip install vllm
vllm serve mistralai/Mistral-7B-Instruct-v0.2 --port 8000
```

### Option B: llama.cpp (Most efficient)

```bash
# Install llama.cpp
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
make

# Download model and run server
./server -m models/mistral-7b-instruct.gguf --port 8080
```

### Option C: Sentence Transformers (For embeddings)

```bash
pip install sentence-transformers
# Use in code directly - no server needed
```

## Implementation Strategy

### Phase 1: Local Embeddings (Easiest Win)

**Benefits:**
- No API costs
- Much faster (local GPU)
- No rate limits
- Works great with 4070Ti

**Models to consider:**
- `BAAI/bge-small-en-v1.5` (384 dim) - Fast, good quality
- `BAAI/bge-base-en-v1.5` (768 dim) - Better quality
- `sentence-transformers/all-MiniLM-L6-v2` (384 dim) - Very fast
- `intfloat/e5-small-v2` (384 dim) - Good for retrieval

**Note:** You're using 1536 dim (OpenAI). You can:
1. Switch to 384/768 dim models (may need to re-index)
2. Use `BAAI/bge-large-en-v1.5` (1024 dim) - closer match
3. Keep 1536 and use a model that supports it

### Phase 2: Local LLM for RAG Generation

Replace `GenerationService` to use Ollama instead of OpenAI.

**Models that work well:**
- `llama3.1:8b` - Good balance
- `mistral:7b` - Excellent for RAG
- `qwen2.5:7b` - Great instruction following

### Phase 3: Local LLM for Entity Extraction

Replace EDL extractor to use local model.

### Phase 4: Hybrid Agent (Optional)

Keep OpenAI for complex tool calling, use local for simpler reasoning.

## Cost Savings Estimate

**Current (OpenAI):**
- Embeddings: ~$0.02 per 1M tokens
- GPT-4o-mini: ~$0.15/$0.60 per 1M tokens (input/output)

**With Local:**
- Embeddings: $0 (electricity only)
- LLM: $0 (electricity only)

**For high-volume ingestion, this saves significant money!**

## Next Steps

1. Install Ollama
2. Test local embeddings
3. Update `EmbeddingService` to support local models
4. Gradually migrate other services
