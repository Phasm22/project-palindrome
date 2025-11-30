#!/bin/bash
# Add Docker's official repo and install docker-compose-plugin

set -e

echo "🐳 Adding Docker's official repository and installing Compose plugin..."
echo ""

# Check if docker compose already works
if docker compose version &> /dev/null 2>&1; then
    echo "✓ Docker Compose plugin is already working!"
    docker compose version
    exit 0
fi

# Install prerequisites
echo "📦 Installing prerequisites..."
sudo apt update
sudo apt install -y ca-certificates curl gnupg lsb-release

# Add Docker's official GPG key
echo "🔑 Adding Docker's GPG key..."
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Set up the repository
echo "📝 Setting up Docker repository..."
ARCH=$(dpkg --print-architecture)
CODENAME=$(lsb_release -cs)
echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${CODENAME} stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Update and install docker-compose-plugin
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
    echo "  sudo apt install -y docker-compose-plugin"
    exit 1
fi
