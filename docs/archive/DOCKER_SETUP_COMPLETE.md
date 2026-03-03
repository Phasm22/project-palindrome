# Complete Docker Setup

## Current Issue
You're not in the docker group yet, even though you may have run the command.

## Solution

Run this complete setup script (it will ask for your sudo password):

```bash
./scripts/setup-docker-permissions.sh
```

This script will:
1. Add you to the docker group (requires sudo)
2. Automatically activate the group in a new shell

## Alternative: Manual Steps

If the script doesn't work, do it manually:

```bash
# 1. Add yourself to docker group
sudo usermod -aG docker $USER

# 2. Activate the group in current shell
newgrp docker

# 3. Verify it worked
groups
docker ps

# 4. Start services
./scripts/start-services.sh
```

## If You Still Get Permission Errors

1. **Make sure Docker service is running:**
   ```bash
   sudo systemctl start docker
   sudo systemctl enable docker
   ```

2. **Verify you're in the docker group:**
   ```bash
   groups | grep docker
   ```
   If it's not there, run `sudo usermod -aG docker $USER` again

3. **Activate the group:**
   ```bash
   newgrp docker
   ```

4. **Check docker socket permissions:**
   ```bash
   ls -la /var/run/docker.sock
   ```
   Should show `root docker` as owner/group
