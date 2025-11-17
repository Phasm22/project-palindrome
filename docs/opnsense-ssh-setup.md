# OPNsense SSH Setup Guide

## Quick Answer

**Yes, users created in the OPNsense GUI are system users**, but you need to:

1. Enable SSH access in OPNsense
2. Grant the user shell access permissions
3. Configure authentication (password or SSH key)

## Step-by-Step Setup

### 1. Enable SSH in OPNsense

1. Go to **System > Settings > Administration**
2. Scroll to **Secure Shell**
3. Enable **SSH** (check the box)
4. Set **SSH Port** (default: 22)
5. Configure **SSH Key Only** if you want key-based auth only
6. Click **Save**

### 2. Grant User Shell Access

For existing GUI users:

1. Go to **System > Access > Users**
2. Click **Edit** on the user you want to enable SSH for
3. Under **Groups**, ensure the user is in a group with shell access
4. Or create/edit a group with shell access enabled
5. **Shell** dropdown should be set to a shell (e.g., `/bin/sh`, `/bin/csh`, `/usr/local/bin/bash`)

**OR** use root (easiest for initial setup):

- Root user exists by default
- Just needs SSH enabled (step 1)
- Use root's password or SSH key

### 3. Test SSH Access

From your Mac:

```bash
# Test password auth
ssh root@172.16.0.1

# Test with SSH key (if configured)
ssh -i ~/.ssh/id_rsa root@172.16.0.1
```

### 4. Configure Palindrome Agent

Once SSH works, add credentials to your `.env`:

```bash
# Option 1: SSH Key (Recommended)
export SSH_KEY_172_16_0_1="$(cat ~/.ssh/id_rsa)"

# Option 2: Password (Less secure)
export SSH_USER_172_16_0_1="root"
export SSH_PASSWORD_172_16_0_1="your-opnsense-root-password"
```

## Security Best Practices

1. **Use SSH Keys** instead of passwords
2. **Disable root login** if possible (create a dedicated user)
3. **Use key-only authentication** in OPNsense settings
4. **Restrict SSH to specific IPs** if possible

## Troubleshooting

### "Permission denied (publickey,password)"
- SSH is enabled but user doesn't have shell access
- Check user's shell setting in OPNsense GUI
- Try using root user first

### "Connection refused"
- SSH service not enabled in OPNsense
- Check firewall rules (SSH should be allowed from your IP)

### "Host key verification failed"
- First time connecting - accept the host key
- Or add to `~/.ssh/known_hosts` manually

## OPNsense Menu System

**Important**: OPNsense uses an interactive menu system when you SSH in. The Palindrome SSH tool automatically:
1. Connects via SSH
2. Selects option **8** (Shell) from the menu
3. Executes your command
4. Exits cleanly

You don't need to manually select the shell option - the tool handles it automatically.

## Quick Test Command

```bash
# Test SSH connection (interactive - you'll see the menu)
ssh root@172.16.0.1

# Test direct command (if your SSH config supports it)
ssh -o ConnectTimeout=5 root@172.16.0.1 "uptime"
```

If SSH works, Palindrome's SSH tool will work too! The tool automatically handles the OPNsense menu system.

