# Quick Start: Fix Docker Compose

## Current Situation
- ✅ Docker is installed (`docker.io` from Ubuntu repos)
- ❌ Docker Compose plugin is not available (needs Docker's official repo)

## Solution

Run this script to add Docker's official repository and install the Compose plugin:

```bash
./scripts/add-docker-repo-and-install-compose.sh
```

This will:
1. Add Docker's official GPG key and repository
2. Install `docker-compose-plugin` (works with your existing Docker)
3. Verify it works

## Then Start Services

```bash
./scripts/start-services.sh
```

## Manual Steps (if script doesn't work)

```bash
# 1. Install prerequisites
sudo apt update
sudo apt install -y ca-certificates curl gnupg lsb-release

# 2. Add Docker's GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# 3. Add Docker repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# 4. Install docker-compose-plugin
sudo apt update
sudo apt install -y docker-compose-plugin

# 5. Verify
docker compose version
```
