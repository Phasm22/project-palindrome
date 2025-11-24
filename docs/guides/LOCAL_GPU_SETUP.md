# Local GPU Setup Guide (4070Ti)

## Overview

This guide shows how to use your local GPU (4070Ti) for embeddings and LLM inference instead of sending everything to OpenAI.

## Quick Start

### 1. Start Ollama Service

```bash
docker compose up -d ollama
```

### 2. Setup Recommended Models

```bash
bun run ollama:setup
```

This will pull:
- `nomic-embed-text` - Embedding model (768 dim)
- `mistral:7b` - LLM for RAG generation
- `llama3.1:8b` - Alternative LLM

### 3. Configure Environment

Add to your `.env` file:

```bash
# Use local models
EMBEDDINGS_PROVIDER=local
LOCAL_EMBED_MODEL=nomic-embed-text

LLM_PROVIDER=local
LOCAL_LLM_MODEL=mistral:7b

# Ollama URL (default: http://localhost:11434)
OLLAMA_BASE_URL=http://localhost:11434
```

### 4. Test

```bash
# Test Ollama
bun run ollama:test

# Test embeddings
bun run pce:test-redaction
```

## Provider Modes

### `openai` (Default)
- Uses OpenAI for all embeddings/LLM
- Requires `OPENAI_API_KEY`

### `local`
- Uses Ollama for all embeddings/LLM
- Requires Ollama running
- Falls back to OpenAI if Ollama unavailable

### `mixed`
- Tries local first, falls back to OpenAI
- Best of both worlds
- Good for gradual migration

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDINGS_PROVIDER` | `openai` | `openai` \| `local` \| `mixed` |
| `LOCAL_EMBED_MODEL` | `nomic-embed-text` | Ollama embedding model |
| `LLM_PROVIDER` | `openai` | `openai` \| `local` \| `mixed` |
| `LOCAL_LLM_MODEL` | `mistral:7b` | Ollama LLM model |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API URL |

## Model Recommendations for 4070Ti

### Embeddings
- `nomic-embed-text` (768 dim) - Good quality, fast
- `bge-base-en-v1.5` (768 dim) - Better quality
- `bge-large-en-v1.5` (1024 dim) - Best quality

### LLMs
- `mistral:7b` - Excellent for RAG, fits in 16GB
- `llama3.1:8b` - Good balance
- `qwen2.5:7b` - Great for tool calling

## Managing Models

```bash
# List installed models
bun run ollama:list

# Pull a new model
bun run ollama:pull mistral:7b

# Test a model
bun run ollama:test mistral:7b

# Remove a model (via script)
./scripts/ollama-setup.sh remove mistral:7b
```

## GPU Passthrough

The `docker-compose.yml` includes GPU support. To enable:

1. Install nvidia-docker (if not already):
   ```bash
   distribution=$(. /etc/os-release;echo $ID$VERSION_ID)
   curl -s -L https://nvidia.github.io/nvidia-docker/gpgkey | sudo apt-key add -
   curl -s -L https://nvidia.github.io/nvidia-docker/$distribution/nvidia-docker.list | sudo tee /etc/apt/sources.list.d/nvidia-docker.list
   sudo apt-get update && sudo apt-get install -y nvidia-docker2
   sudo systemctl restart docker
   ```

2. The `docker-compose.yml` already has GPU configuration - just start:
   ```bash
   docker compose up -d ollama
   ```

## Hot Reload Models

Models can be loaded/unloaded without restarting Ollama:

```bash
# Pull a new model (loads automatically)
docker exec ollama ollama pull qwen2.5:7b

# List loaded models
docker exec ollama ollama list

# Unload a model from memory (keeps on disk)
docker exec ollama ollama ps
```

## Cost Savings

**Before (OpenAI):**
- Embeddings: ~$0.02 per 1M tokens
- LLM: ~$0.15-0.60 per 1M tokens

**After (Local):**
- Embeddings: $0 (electricity only)
- LLM: $0 (electricity only)

For high-volume ingestion, this saves significant money!

## Troubleshooting

### Ollama not responding
```bash
# Check if running
docker compose ps ollama

# Check logs
docker compose logs ollama

# Restart
docker compose restart ollama
```

### GPU not detected
```bash
# Check NVIDIA driver
nvidia-smi

# Check Docker GPU support
docker run --rm --gpus all nvidia/cuda:11.0.3-base-ubuntu20.04 nvidia-smi
```

### Model dimension mismatch
If switching embedding models, you may need to re-index your vector store:
```bash
# Clear and re-index
bun run pce:ingest-proxmox --reindex
```

## Next Steps

1. Start with `mixed` mode to test
2. Monitor performance and costs
3. Switch to `local` once confident
4. Experiment with different models for your use case

