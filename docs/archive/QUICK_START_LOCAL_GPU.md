# Quick Start: Local GPU Setup

## 1. Start Ollama

```bash
docker compose up -d ollama
```

## 2. Setup Models

```bash
bun run ollama:setup
```

## 3. Configure .env

Add to your `.env`:

```bash
EMBEDDINGS_PROVIDER=local
LOCAL_EMBED_MODEL=nomic-embed-text

LLM_PROVIDER=local
LOCAL_LLM_MODEL=mistral:7b
```

## 4. Test

```bash
# Test Ollama
bun run ollama:test

# Test your app
bun run pce:api
```

## Provider Modes

- `openai` - Use OpenAI (default)
- `local` - Use Ollama only
- `mixed` - Try local, fallback to OpenAI

## Commands

```bash
bun run ollama:setup    # Setup recommended models
bun run ollama:list     # List installed models
bun run ollama:pull     # Pull a model
bun run ollama:test     # Test a model
```

See `docs/guides/LOCAL_GPU_SETUP.md` for full documentation.
