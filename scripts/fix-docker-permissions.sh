#!/bin/bash
# Fix Docker permissions by adding user to docker group

set -e

echo "🔧 Fixing Docker permissions..."
echo ""

# Check if user is already in docker group
if groups | grep -q docker; then
    echo "✓ User is already in docker group!"
    echo ""
    echo "If you still get permission errors, try:"
    echo "  1. Log out and log back in"
    echo "  2. Or run: newgrp docker"
    exit 0
fi

echo "Adding user to docker group..."
sudo usermod -aG docker $USER

echo ""
echo "✅ User added to docker group!"
echo ""
echo "⚠️  IMPORTANT: You need to log out and log back in for this to take effect."
echo ""
echo "Or you can activate it in the current session by running:"
echo "  newgrp docker"
echo ""
echo "After that, try starting services again:"
echo "  ./scripts/start-services.sh"
