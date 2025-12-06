#!/bin/bash
# Find the missing ~503GB of disk space
# Run with: sudo ./scripts/find-missing-space.sh

echo "=== Finding Missing Disk Space ==="
echo ""
echo "Total used: 569GB"
echo "Known directories: ~66GB"
echo "Missing: ~503GB"
echo ""

echo "=== Checking /var/lib/docker (Docker storage) ==="
if [ -d /var/lib/docker ]; then
    echo "Docker directory sizes:"
    sudo du -sh /var/lib/docker/* 2>/dev/null | sort -h | tail -10
    echo ""
    echo "Docker overlay2 (container layers):"
    sudo du -sh /var/lib/docker/overlay2 2>/dev/null || echo "Cannot access"
    echo ""
    echo "Docker total:"
    sudo du -sh /var/lib/docker 2>/dev/null
else
    echo "Docker directory not found"
fi
echo ""

echo "=== Checking for deleted files still held open ==="
echo "Large deleted files (>1GB) still open:"
sudo lsof +L1 2>/dev/null | grep -E "REG.*deleted" | awk '{if ($7 > 1073741824) print $2, $7/1073741824"GB", $9}' | sort -k2 -rn | head -10
echo ""

echo "=== Checking all /var/lib subdirectories ==="
sudo du -sh /var/lib/* 2>/dev/null | sort -h | tail -20
echo ""

echo "=== Checking for large files in /var/lib ==="
echo "Files >10GB in /var/lib:"
sudo find /var/lib -type f -size +10G -exec ls -lh {} \; 2>/dev/null | awk '{print $5, $9}'
echo ""

echo "=== Docker system info ==="
docker system df -v 2>/dev/null | head -30
echo ""

echo "=== Recommendation ==="
echo "In ncdu, navigate to /var/lib to see detailed breakdown"
echo "Press Enter on /var/lib, then check:"
echo "  - /var/lib/docker (Docker storage)"
echo "  - /var/lib/snapd (Snap packages)"
echo "  - Other large directories"

