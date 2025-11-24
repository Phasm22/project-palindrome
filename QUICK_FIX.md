# Quick Fix: Broken docker-compose

## Problem
The standalone `docker-compose` (1.29.2) is broken on Python 3.12+ due to missing `distutils` module.

## Solution

Run this script to fix it:
```bash
./scripts/fix-docker-compose.sh
```

Or manually:
```bash
# Remove broken docker-compose
sudo apt remove -y docker-compose

# Install Docker Compose plugin (modern, doesn't have Python dependency)
sudo apt update
sudo apt install -y docker-compose-plugin

# Verify it works
docker compose version
```

## Then start services
```bash
./scripts/start-services.sh
```
