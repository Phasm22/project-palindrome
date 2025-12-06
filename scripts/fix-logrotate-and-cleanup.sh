#!/bin/bash
# Quick fix for logrotate permissions and cleanup old syslog file
# This fixes the issues found after running fix-storage-retention.sh

set -e

echo "=== Fixing Logrotate and Cleaning Up ==="

# 1. Fix logrotate configuration
echo ""
echo "1. Fixing logrotate configuration..."
if ! grep -q "^su " /etc/logrotate.d/rsyslog; then
    echo "   Adding 'su root syslog' directive..."
    sudo sed -i '1i su root syslog' /etc/logrotate.d/rsyslog
    echo "   ✓ Logrotate configuration fixed"
else
    echo "   ✓ Logrotate already has su directive"
fi

# 2. Remove old syslog files to free space
echo ""
echo "2. Removing old syslog files..."
OLD_FILES=$(ls /var/log/syslog.old-* 2>/dev/null | wc -l)
if [ "$OLD_FILES" -gt 0 ]; then
    echo "   Found $OLD_FILES old syslog file(s)..."
    for file in /var/log/syslog.old-*; do
        SIZE=$(du -sh "$file" 2>/dev/null | awk '{print $1}')
        echo "   Removing $file ($SIZE)..."
        sudo rm -f "$file"
    done
    echo "   ✓ Old syslog files removed"
else
    echo "   ✓ No old syslog files found"
fi

# 3. Verify logrotate works
echo ""
echo "3. Verifying logrotate configuration..."
if sudo logrotate -d /etc/logrotate.d/rsyslog 2>&1 | grep -q "error: skipping"; then
    echo "   ⚠️  Warning: logrotate still has issues"
    sudo logrotate -d /etc/logrotate.d/rsyslog 2>&1 | grep "error: skipping" | head -3
else
    echo "   ✓ Logrotate configuration is valid"
fi

# 4. Show disk usage
echo ""
echo "=== Current disk usage ==="
df -h / | tail -1

echo ""
echo "=== Fix complete ==="

