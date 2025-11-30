# Fix Docker Permission Denied Error

## Problem
```
permission denied while trying to connect to the Docker daemon socket
```

This happens because your user is not in the `docker` group.

## Quick Fix

Run this script:
```bash
./scripts/fix-docker-permissions.sh
```

Then **log out and log back in** (or run `newgrp docker`).

## Manual Fix

```bash
# Add your user to the docker group
sudo usermod -aG docker $USER

# Log out and log back in, OR activate in current session:
newgrp docker
```

## Verify

After logging back in, verify you can run Docker without sudo:
```bash
docker ps
```

If it works, start the services:
```bash
./scripts/start-services.sh
```
