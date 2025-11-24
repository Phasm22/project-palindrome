#!/bin/bash
# Setup and manage Ollama models for local GPU inference

set -e

OLLAMA_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"

function check_ollama() {
    if ! curl -s "${OLLAMA_URL}/api/tags" > /dev/null 2>&1; then
        echo "❌ Ollama is not running at ${OLLAMA_URL}"
        echo "   Start it with: docker compose up -d ollama"
        exit 1
    fi
    echo "✓ Ollama is running"
}

function list_models() {
    echo "📦 Available models:"
    curl -s "${OLLAMA_URL}/api/tags" | jq -r '.models[] | "  - \(.name) (\(.size | . / 1024 / 1024 / 1024 | floor)GB)"' || echo "  (none)"
}

function pull_model() {
    local model=$1
    if [ -z "$model" ]; then
        echo "Usage: $0 pull <model-name>"
        echo "Example: $0 pull mistral:7b"
        exit 1
    fi
    
    echo "📥 Pulling model: $model"
    echo "   This may take a while depending on model size..."
    
    if docker ps | grep -q ollama; then
        docker exec ollama ollama pull "$model"
    else
        ollama pull "$model"
    fi
    
    echo "✅ Model pulled: $model"
}

function remove_model() {
    local model=$1
    if [ -z "$model" ]; then
        echo "Usage: $0 remove <model-name>"
        exit 1
    fi
    
    echo "🗑️  Removing model: $model"
    
    if docker ps | grep -q ollama; then
        docker exec ollama ollama rm "$model"
    else
        ollama rm "$model"
    fi
    
    echo "✅ Model removed: $model"
}

function setup_recommended() {
    echo "🚀 Setting up recommended models for 4070Ti..."
    echo ""
    
    check_ollama
    
    echo "📥 Pulling embedding model..."
    pull_model "nomic-embed-text"
    
    echo ""
    echo "📥 Pulling LLM models..."
    pull_model "mistral:7b"
    pull_model "llama3.1:8b"
    
    echo ""
    echo "✅ Setup complete!"
    echo ""
    echo "Recommended environment variables:"
    echo "  EMBEDDINGS_PROVIDER=local"
    echo "  LOCAL_EMBED_MODEL=nomic-embed-text"
    echo "  LLM_PROVIDER=local"
    echo "  LOCAL_LLM_MODEL=mistral:7b"
}

function test_model() {
    local model=$1
    if [ -z "$model" ]; then
        model="${LOCAL_LLM_MODEL:-mistral:7b}"
    fi
    
    echo "🧪 Testing model: $model"
    echo ""
    
    if docker ps | grep -q ollama; then
        docker exec ollama ollama run "$model" "Hello! Can you respond with just 'OK'?"
    else
        ollama run "$model" "Hello! Can you respond with just 'OK'?"
    fi
}

case "${1:-help}" in
    list)
        check_ollama
        list_models
        ;;
    pull)
        check_ollama
        pull_model "$2"
        ;;
    remove)
        check_ollama
        remove_model "$2"
        ;;
    setup)
        setup_recommended
        ;;
    test)
        check_ollama
        test_model "$2"
        ;;
    *)
        echo "Ollama Model Manager"
        echo ""
        echo "Usage: $0 <command> [args]"
        echo ""
        echo "Commands:"
        echo "  list              - List installed models"
        echo "  pull <model>      - Pull/download a model"
        echo "  remove <model>    - Remove a model"
        echo "  setup             - Setup recommended models for 4070Ti"
        echo "  test [model]      - Test a model (default: mistral:7b)"
        echo ""
        echo "Examples:"
        echo "  $0 setup"
        echo "  $0 pull mistral:7b"
        echo "  $0 list"
        echo "  $0 test mistral:7b"
        ;;
esac

