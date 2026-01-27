# Systemd Service Setup

This guide shows how to run all Palindrome services (Docker Compose, API, Dashboard) as a single systemd service.

## Quick Start

### Option 1: Automated Installation (Recommended)

```bash
sudo bash scripts/install-systemd-service.sh
sudo systemctl enable palindrome-services
sudo systemctl start palindrome-services
sudo systemctl status palindrome-services
```

The installation script automatically:
- Detects your username
- Finds your bun binary path
- Configures the service file
- Installs it to systemd

### Option 2: Manual Installation

1. **Edit the service file** to set your username and bun path:
   ```bash
   nano scripts/palindrome-services.service
   ```
   Update:
   - `User=tj` → your username
   - `Group=tj` → your username  
   - `WorkingDirectory=/home/tj/project-palindrome` → your project path
   - `ExecStart=/home/tj/.bun/bin/bun` → path to your bun binary (run `which bun` to find it)

2. **Copy the service file:**
   ```bash
   sudo cp scripts/palindrome-services.service /etc/systemd/system/palindrome-services.service
   ```

3. **Reload systemd:**
   ```bash
   sudo systemctl daemon-reload
   ```

4. **Enable and start:**
   ```bash
   sudo systemctl enable palindrome-services
   sudo systemctl start palindrome-services
   ```

5. **Check status:**
   ```bash
   sudo systemctl status palindrome-services
   ```

## Service Management

```bash
# Start
sudo systemctl start palindrome-services

# Stop
sudo systemctl stop palindrome-services

# Restart
sudo systemctl restart palindrome-services

# View logs
sudo journalctl -u palindrome-services -f

# Check status
sudo systemctl status palindrome-services
```

## What It Starts

1. **Docker Compose** (Qdrant, Neo4j)
   - Waits for services to be healthy before continuing

2. **Palindrome API Server** (port 4000)
   - Logs to `logs/palindrome-api.log`

3. **Dashboard Server** (ports 8080/8443)
   - Logs to `logs/dashboard.log`

## Configuration

### Environment Variables

Edit the service file to add environment variables:

```ini
[Service]
Environment="PCE_API_PORT=4000"
Environment="OPENAI_API_KEY=your-key"
Environment="NEO4J_URI=bolt://localhost:7687"
# ... etc
```

### Working Directory

The service runs from `/home/username/project-palindrome`. Update the `WorkingDirectory` in the service file if your path is different.

### User/Group

The service runs as the user specified in the service file. Make sure:
- The user has Docker permissions (in `docker` group)
- The user owns the project directory
- The user can write to the `logs/` directory

## Troubleshooting

### Service won't start

1. Check logs:
   ```bash
   sudo journalctl -u palindrome-services -n 50
   ```

2. Check Docker:
   ```bash
   sudo systemctl status docker
   docker ps
   ```

3. Check permissions:
   ```bash
   ls -la /home/username/project-palindrome
   groups  # Should include 'docker'
   ```

### Services crash

The service is configured to restart automatically. Check logs to see why:
```bash
sudo journalctl -u palindrome-services -f
```

### Port conflicts

If ports are already in use:
- Check what's using them: `sudo lsof -i :4000` or `sudo lsof -i :8080`
- Stop conflicting services or change ports in the service file

## Manual Testing

Test the startup script manually before using systemd:

```bash
cd /home/username/project-palindrome
bun run scripts/start-all.ts
```

Press Ctrl+C to stop (it will gracefully shut down all services).

