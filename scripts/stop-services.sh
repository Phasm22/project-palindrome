#!/bin/bash
# Stop Qdrant and Neo4j services

set -e

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Error: Docker is not installed."
    exit 1
fi

# Check if docker compose (plugin) is available
if docker compose version &> /dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
# Check if docker-compose (standalone) is available
elif command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
else
    echo "❌ Error: Docker Compose not found."
    exit 1
fi

cd "$(dirname "$0")/.."

echo "🛑 Stopping PCE services..."
$COMPOSE_CMD down

echo "✅ Services stopped!"
