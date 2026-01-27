#!/bin/bash
# Install systemd service for Palindrome services

set -e
set -o pipefail

# Trap errors to show them
trap 'echo "❌ Error on line $LINENO. Exit code: $?"' ERR

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_FILE="$SCRIPT_DIR/palindrome-services.service"
SYSTEMD_FILE="/etc/systemd/system/palindrome-services.service"

echo "🔧 Installing Palindrome Services systemd unit..."
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "❌ This script must be run with sudo"
    echo "   sudo bash scripts/install-systemd-service.sh"
    exit 1
fi

# Get the original user (not root)
CURRENT_USER=""
if [ -n "$SUDO_USER" ]; then
    CURRENT_USER="$SUDO_USER"
elif command -v logname >/dev/null 2>&1; then
    CURRENT_USER=$(logname 2>/dev/null || echo "")
fi

if [ -z "$CURRENT_USER" ] || [ "$CURRENT_USER" = "root" ]; then
    echo "❌ Could not determine original user."
    echo "   SUDO_USER='$SUDO_USER'"
    echo ""
    echo "   Please run with:"
    echo "   SUDO_USER=\$USER sudo bash scripts/install-systemd-service.sh"
    echo ""
    echo "   Or ensure SUDO_USER is set:"
    echo "   sudo -E bash scripts/install-systemd-service.sh"
    exit 1
fi

# Get bun path from the original user's environment
BUN_PATH=""
if sudo -u "$CURRENT_USER" command -v bun >/dev/null 2>&1; then
    BUN_PATH=$(sudo -u "$CURRENT_USER" command -v bun)
elif [ -x "/home/$CURRENT_USER/.bun/bin/bun" ]; then
    BUN_PATH="/home/$CURRENT_USER/.bun/bin/bun"
else
    echo "❌ Bun not found for user $CURRENT_USER"
    echo "   Please ensure bun is installed and in PATH"
    exit 1
fi

echo "Project root: $PROJECT_ROOT"
echo "User: $CURRENT_USER"
echo "Bun path: $BUN_PATH"
echo ""

# Check if service file exists
if [ ! -f "$SERVICE_FILE" ]; then
    echo "❌ Service file not found: $SERVICE_FILE"
    exit 1
fi

# Create a temporary service file with user-specific values
TEMP_SERVICE=$(mktemp)
sed "s|User=tj|User=$CURRENT_USER|g" "$SERVICE_FILE" | \
sed "s|Group=tj|Group=$CURRENT_USER|g" | \
sed "s|/home/tj/project-palindrome|$PROJECT_ROOT|g" | \
sed "s|/home/tj/.bun/bin/bun|$BUN_PATH|g" > "$TEMP_SERVICE"

# Copy to systemd
cp "$TEMP_SERVICE" "$SYSTEMD_FILE"
rm "$TEMP_SERVICE"

echo "✅ Service file installed to $SYSTEMD_FILE"
echo ""

# Reload systemd
systemctl daemon-reload

echo "✅ Systemd reloaded"
echo ""
echo "Next steps:"
echo "  1. Enable service:  sudo systemctl enable palindrome-services"
echo "  2. Start service:   sudo systemctl start palindrome-services"
echo "  3. Check status:    sudo systemctl status palindrome-services"
echo "  4. View logs:       sudo journalctl -u palindrome-services -f"
echo ""

