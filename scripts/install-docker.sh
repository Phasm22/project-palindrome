#!/bin/bash
# Install Docker and Docker Compose on Ubuntu

set -e

echo "🐳 Installing Docker and Docker Compose on Ubuntu..."
echo ""

# Check if already installed
if command -v docker &> /dev/null && docker compose version &> /dev/null 2>&1; then
    echo "✓ Docker and Docker Compose are already installed!"
    docker --version
    docker compose version
    exit 0
fi

# Update package index
echo "📦 Updating package index..."
sudo apt update

# Install prerequisites
echo "📦 Installing prerequisites..."
sudo apt install -y ca-certificates curl gnupg lsb-release

# Add Docker's official GPG key
echo "🔑 Adding Docker's GPG key..."
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Set up the repository
echo "📝 Setting up Docker repository..."
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine with Compose plugin
echo "📦 Installing Docker Engine and Compose plugin..."
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add user to docker group
echo "👤 Adding user to docker group..."
sudo usermod -aG docker $USER

echo ""
echo "✅ Docker and Docker Compose installed successfully!"
echo ""
echo "⚠️  IMPORTANT: You need to log out and log back in (or run 'newgrp docker')"
echo "   for the docker group changes to take effect."
echo ""
echo "After logging back in, verify installation:"
echo "  docker --version"
echo "  docker compose version"
echo ""
echo "Then start the services:"
echo "  ./scripts/start-services.sh"
