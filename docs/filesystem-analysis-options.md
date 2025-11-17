# Filesystem Analysis Options for OPNsense

## Current Limitations
- OPNsense API only provides high-level disk usage (total used/available)
- No directory-level breakdown
- No file type analysis
- No largest files identification

## Option 1: SSH Tool (Recommended)
Add a new tool to Palindrome that can SSH into OPNsense and execute commands:

**Commands to run:**
- `du -sh /*` - Directory sizes
- `df -h` - Filesystem usage breakdown
- `du -h --max-depth=1 /var/log` - Log directory sizes
- `find /var -type f -size +100M` - Large files

**Implementation:**
- Create `SSHTool` that extends `BaseTool`
- Use `ssh2` or `node-ssh` library
- Execute read-only commands
- Parse output and return structured data

## Option 2: Custom OPNsense API Endpoint
If OPNsense supports custom API endpoints:
- Create a plugin/script on OPNsense that exposes filesystem data
- Add endpoint to `OpnsenseTool`

## Option 3: Webhook/Webhook Receiver
- Set up a webhook receiver on OPNsense
- Run cron job that collects filesystem data
- Expose via HTTP endpoint
- Call from Palindrome agent

## Option 4: MCP Server Extension
- Extend the pixelworld MCP server
- Add filesystem analysis capabilities
- Requires modifying the MCP server code

## Recommended Approach
**SSH Tool** is the most straightforward:
- No OPNsense modifications needed
- Direct access to filesystem commands
- Can be read-only (no write permissions)
- Works with existing Palindrome tool framework

