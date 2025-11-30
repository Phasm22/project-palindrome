#!/bin/bash
# Start Qdrant and Neo4j services

set -e

echo "🚀 Starting PCE services (Qdrant + Neo4j)..."

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Error: Docker is not installed."
    echo ""
    echo "Please install Docker first. See INSTALL_DOCKER.md for instructions, or run:"
    echo "  sudo apt update"
    echo "  sudo apt install -y docker.io docker-compose"
    echo ""
    echo "Or install Docker Engine with Compose plugin:"
    echo "  See INSTALL_DOCKER.md for full instructions"
    exit 1
fi

# Check if docker compose (plugin) is available
if docker compose version &> /dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
    echo "✓ Using Docker Compose plugin"
# Check if docker-compose (standalone) is available, but test if it works
elif command -v docker-compose &> /dev/null; then
    # Test if docker-compose actually works (it might be broken on Python 3.12+)
    if docker-compose version &> /dev/null 2>&1; then
        COMPOSE_CMD="docker-compose"
        echo "✓ Using docker-compose standalone"
    else
        echo "❌ Error: docker-compose is installed but broken (likely Python 3.12 compatibility issue)."
        echo ""
        echo "Fix by installing Docker Compose plugin:"
        echo "  sudo apt remove -y docker-compose"
        echo "  sudo apt install -y docker-compose-plugin"
        echo ""
        echo "Or install Docker Engine with Compose plugin:"
        echo "  See INSTALL_DOCKER.md or run: ./scripts/install-docker.sh"
        exit 1
    fi
else
    echo "❌ Error: Docker Compose not found."
    echo ""
    echo "Install Docker Compose plugin (recommended):"
    echo "  sudo apt install -y docker-compose-plugin"
    echo ""
    echo "Or install Docker Engine with Compose plugin:"
    echo "  See INSTALL_DOCKER.md or run: ./scripts/install-docker.sh"
    exit 1
fi

cd "$(dirname "$0")/.."

# Start services
$COMPOSE_CMD up -d

echo ""
echo "✅ Services started!"
echo ""
echo "📊 Service URLs:"
echo "  Qdrant:  http://localhost:6333/dashboard"
echo "  Neo4j:   http://localhost:7474"
echo ""
echo "🔍 Check status:"
echo "  $COMPOSE_CMD ps"
echo ""
echo "🛑 Stop services:"
echo "  $COMPOSE_CMD down"
echo ""
echo "📋 View logs:"
echo "  $COMPOSE_CMD logs -f"
