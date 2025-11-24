#!/bin/bash
# Fix broken docker-compose by installing the Docker Compose plugin

set -e

echo "🔧 Fixing Docker Compose installation..."
echo ""

# Check if docker compose plugin already works
if docker compose version &> /dev/null 2>&1; then
    echo "✓ Docker Compose plugin is already working!"
    docker compose version
    exit 0
fi

echo "The standalone docker-compose is broken (Python 3.12 compatibility issue)."
echo "Installing Docker Compose plugin..."
echo ""

# Remove broken docker-compose
echo "📦 Removing broken docker-compose..."
sudo apt remove -y docker-compose

# Install Docker Compose plugin
echo "📦 Installing Docker Compose plugin..."
sudo apt update
sudo apt install -y docker-compose-plugin

echo ""
echo "✅ Docker Compose plugin installed!"
echo ""
echo "Verifying installation..."
if docker compose version &> /dev/null 2>&1; then
    docker compose version
    echo ""
    echo "✓ Success! You can now run: ./scripts/start-services.sh"
else
    echo "❌ Installation may have failed. Try:"
    echo "  sudo apt install -y docker.io docker-compose-plugin"
    exit 1
fi
