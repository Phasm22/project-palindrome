#!/bin/bash
# Complete Docker permissions setup

set -e

echo "🔧 Setting up Docker permissions..."
echo ""

# Check if user is already in docker group
if id -nG | grep -q docker; then
    echo "✓ User is already in docker group!"
    echo ""
    echo "If you still get permission errors, you need to activate the group:"
    echo "  Run: newgrp docker"
    echo "  Or log out and log back in"
    exit 0
fi

echo "Step 1: Adding user to docker group..."
echo "  (This requires sudo password)"
sudo usermod -aG docker $USER

echo ""
echo "✅ User added to docker group!"
echo ""
echo "Step 2: Activating docker group in current shell..."
echo "  Starting new shell with docker permissions..."
echo ""
echo "After the new shell starts, you can run:"
echo "  ./scripts/start-services.sh"
echo ""
echo "To exit the new shell later, type 'exit'"
echo ""
sleep 2

# Start new shell with docker group
exec newgrp docker
