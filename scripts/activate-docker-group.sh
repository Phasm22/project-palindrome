#!/bin/bash
# Activate docker group in current shell session

echo "🔧 Activating docker group in current shell..."
echo ""
echo "This will start a new shell with docker group permissions."
echo "After it starts, you can run: ./scripts/start-services.sh"
echo ""
echo "To exit the new shell, type 'exit'"
echo ""
exec newgrp docker
