#!/bin/bash
# Analyze disk usage to find what's taking up space
# Run with: sudo ./scripts/analyze-disk-usage.sh

set -e

echo "=== Disk Usage Analysis ==="
echo ""
echo "Current disk usage:"
df -h / | tail -1
echo ""

echo "=== Top Directories (excluding /proc, /sys, /dev) ==="
# Scan only common directories that can have large files
for dir in /var /home /usr /opt /tmp /root /snap; do
    if [ -d "$dir" ]; then
        echo "Scanning $dir..."
        sudo du -sh "$dir" 2>/dev/null || true
    fi
done | sort -h
echo ""

echo "=== Docker Usage ==="
docker system df -v 2>/dev/null | grep -A 15 "Local Volumes" || echo "Docker not running or no volumes"
echo ""

echo "=== /var breakdown ==="
sudo du -sh /var/* 2>/dev/null | sort -h | tail -10
echo ""

echo "=== Large Files (>5GB) in common locations ==="
echo "Searching for files larger than 5GB (this may take a moment)..."
for dir in /var /home /opt /usr/local /tmp; do
    if [ -d "$dir" ]; then
        echo "  Checking $dir..."
        sudo find "$dir" -type f -size +5G -exec ls -lh {} \; 2>/dev/null | awk '{print $5, $9}' | head -5
    fi
done
echo ""

echo "=== /var/log breakdown ==="
sudo du -sh /var/log/* 2>/dev/null | sort -h | tail -10
echo ""

echo "=== Quick Summary ==="
echo "Total used: $(df -h / | tail -1 | awk '{print $3}')"
echo "Docker volumes: $(docker system df 2>/dev/null | grep 'Local Volumes' | awk '{print $4}' || echo 'N/A')"
echo ""

echo "=== For interactive analysis ==="
echo "Run ncdu on specific directories:"
echo "  sudo ncdu /var    # Most likely location for large files"
echo "  sudo ncdu /home"
echo "  sudo ncdu /usr"

