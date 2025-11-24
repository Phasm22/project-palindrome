# Installing Docker on Ubuntu

## Quick Install (Recommended)

```bash
# Update package index
sudo apt update

# Install prerequisites
sudo apt install -y ca-certificates curl gnupg lsb-release

# Add Docker's official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Set up the repository
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add your user to the docker group (so you don't need sudo)
sudo usermod -aG docker $USER

# Verify installation
docker --version
docker compose version
```

**Important:** After adding yourself to the docker group, you need to log out and log back in (or run `newgrp docker`) for the changes to take effect.

## Alternative: Install via Snap (Simpler but may have limitations)

```bash
sudo snap install docker
```

## After Installation

1. **Log out and log back in** (or run `newgrp docker`)
2. **Start the services:**
   ```bash
   ./scripts/start-services.sh
   ```
3. **Verify services are running:**
   ```bash
   docker ps
   ```

## Using the Services

Once Docker is installed and services are running:

- **Qdrant Dashboard:** http://localhost:6333/dashboard
- **Neo4j Browser:** http://localhost:7474
  - Username: `neo4j`
  - Password: `password` (as configured in docker-compose.yml)

## Environment Variables

Make sure your `.env` file has:
```bash
QDRANT_URL=http://localhost:6333
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=password
```
