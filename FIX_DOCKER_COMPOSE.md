# Fix: docker-compose-plugin not found

## Problem
The `docker-compose-plugin` package is not in Ubuntu's default repositories. It's part of Docker Engine, which requires Docker's official repository.

## Solution

You need to install Docker Engine (which includes the Compose plugin). Run:

```bash
./scripts/install-docker-complete.sh
```

This will:
1. Add Docker's official repository
2. Install Docker Engine with Compose plugin
3. Add your user to the docker group

## Manual Installation

If you prefer to do it manually:

```bash
# 1. Update and install prerequisites
sudo apt update
sudo apt install -y ca-certificates curl gnupg lsb-release

# 2. Add Docker's GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# 3. Add Docker repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# 4. Install Docker Engine with Compose plugin
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 5. Add user to docker group
sudo usermod -aG docker $USER
```

## After Installation

1. **Log out and log back in** (or run `newgrp docker`)
2. **Verify:**
   ```bash
   docker --version
   docker compose version
   ```
3. **Start services:**
   ```bash
   ./scripts/start-services.sh
   ```

## Alternative: Use docker.io from Ubuntu repos

If you can't use Docker's official repo, you can use Ubuntu's docker.io package, but it's older:

```bash
sudo apt install -y docker.io
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker $USER
```

Then use `docker-compose` standalone (but it's broken on Python 3.12+), or install docker-compose-plugin separately if available.
