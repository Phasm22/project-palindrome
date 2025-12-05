#!/bin/bash
# Fix deleted files still held open by processes
# This frees up space that's "used" but actually from deleted files

echo "=== Fixing Deleted Files Held Open ==="
echo ""

# Check for large deleted files
echo "Large deleted files (>1GB) still held open:"
sudo lsof +L1 2>/dev/null | grep -E "REG.*deleted" | awk '{if ($7 > 1073741824) {size_gb=$7/1073741824; printf "PID: %s, Size: %.2fGB, File: %s\n", $2, size_gb, $9}}' | sort -k3 -rn | head -10
echo ""

# Check Timeshift status
echo "=== Timeshift Status ==="
if pgrep -f timeshift > /dev/null; then
    echo "⚠️  Timeshift backup is currently running!"
    echo "Process info:"
    ps aux | grep -E "[t]imeshift|[r]sync.*timeshift" | head -3
    echo ""
    echo "The 508GB deleted syslog file is being backed up by Timeshift."
    echo "Once the backup completes, the space will be freed."
    echo ""
    echo "Options:"
    echo "1. Wait for backup to complete (recommended)"
    echo "2. Cancel the backup: sudo killall -9 rsync (NOT recommended - may corrupt backup)"
    echo "3. Configure Timeshift to exclude /var/log/syslog* files"
else
    echo "✓ No Timeshift backup running"
fi
echo ""

# Check other processes
echo "=== Other Processes with Deleted Files ==="
OTHER_PIDS=$(sudo lsof +L1 2>/dev/null | grep -E "REG.*deleted" | awk '{if ($7 > 1073741824 && $2 != "9153") print $2}' | sort -u)
if [ -n "$OTHER_PIDS" ]; then
    for pid in $OTHER_PIDS; do
        echo "PID $pid:"
        ps aux | grep "^[^ ]* *$pid " | grep -v grep || echo "  Process not found"
        echo "  Consider restarting this process to free space"
    done
else
    echo "✓ No other large deleted files held open"
fi
echo ""

# Recommendations
echo "=== Recommendations ==="
echo "1. Wait for Timeshift backup to complete (check with: ps aux | grep timeshift)"
echo "2. After backup completes, space should be freed automatically"
echo "3. Configure Timeshift to exclude large log files:"
echo "   - Edit Timeshift settings"
echo "   - Add to exclude list: /var/log/syslog*"
echo "   - Add: /var/log/*.log"
echo ""
echo "4. To check current disk usage:"
echo "   df -h /"
echo ""
echo "5. To monitor the backup progress:"
echo "   sudo tail -f /run/timeshift/*/backup/timeshift/snapshots/*/rsync-log"

