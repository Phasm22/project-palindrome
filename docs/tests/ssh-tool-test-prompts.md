# SSH Tool Test Prompts

Test prompts for `ssh_execute` and `run_diagnostic_command` tools to validate functionality, stress test, and find edge cases.

## Basic Functionality Tests

### SSH Execute - Basic Operations
```
Check disk usage on OPNsense
```
```
Show me the uptime of the firewall
```
```
List directory sizes in /var on opnsense
```
```
What's the memory usage on prox_big?
```
```
Check network interfaces on yin
```

### Diagnostic Commands - Basic Operations
```
Ping 8.8.8.8
```
```
Traceroute to google.com
```
```
Check if https://google.com is responding
```
```
Ping the OPNsense firewall
```
```
Traceroute to 172.16.0.1
```

## Edge Cases & Error Handling

### Invalid Hosts
```
Check disk usage on nonexistent-host
```
```
Run uptime on 999.999.999.999
```
```
SSH to invalid-host and run df -h
```

### Invalid Commands
```
Run rm -rf / on opnsense
```
```
Execute sudo shutdown now on prox_big
```
```
Try to run cat /etc/shadow on yin
```

### Invalid Diagnostic Targets
```
Ping invalid-hostname-that-does-not-exist
```
```
Traceroute to not-a-valid-ip
```
```
Check HTTP status of not-a-url
```

### Host Alias Resolution
```
Check disk usage on radar (alias for opnsense)
```
```
Show uptime on firewall (alias for opnsense)
```
```
Run df -h on proxbig (alias for prox_big)
```

## Stress Tests

### Multiple Sequential Commands
```
Check disk usage, memory, and uptime on opnsense
```
```
Show me network interfaces, routes, and listening ports on yin
```
```
Check disk usage on all Proxmox nodes
```

### Complex Queries
```
Find all files larger than 100MB in /var on opnsense
```
```
Show me the top 20 processes on prox_big
```
```
List all systemd services on yin
```

### Diagnostic Stress Tests
```
Ping 8.8.8.8, 1.1.1.1, and 172.16.0.1
```
```
Traceroute to multiple destinations: google.com, cloudflare.com, and 172.16.0.1
```
```
Check HTTP status of https://google.com, https://github.com, and https://stackoverflow.com
```

## Integration Tests

### Combined SSH + Diagnostic
```
Ping opnsense and then check its disk usage
```
```
Check if 172.16.0.1 is reachable, then show its uptime
```
```
Traceroute to prox_big and then check its network interfaces
```

### SSH + Proxmox Integration
```
Check disk usage on prox_big and then list all VMs on that node
```
```
Show system resources on yin and compare with Proxmox node status
```

### SSH + OPNsense Integration
```
Check disk usage on opnsense and then list firewall rules
```
```
Show network interfaces on opnsense via SSH and via OPNsense API
```

## Parameter Validation Tests

### Missing Parameters
```
Check disk usage (missing host)
```
```
Run ping (missing target)
```
```
Execute command on opnsense (missing command)
```

### Invalid Parameters
```
Check disk usage on opnsense with command "invalid-command-here"
```
```
Ping with command "traceroute" (wrong command type)
```
```
Run SSH command with category "invalid-category"
```

## Security & Authorization Tests

### Unapproved Commands
```
Try to delete files on opnsense
```
```
Attempt to modify system files on prox_big
```
```
Run a dangerous command on yin
```

### Read-Only Enforcement
```
Try to write to /etc/hosts on opnsense
```
```
Attempt to modify network configuration on prox_big
```

## Performance & Timeout Tests

### Long-Running Commands
```
Find all files in /usr on opnsense (may take time)
```
```
List all processes on prox_big
```
```
Check disk usage recursively in /var on yin
```

### Diagnostic Timeouts
```
Ping a host that doesn't respond (should timeout)
```
```
Traceroute to an unreachable destination
```
```
Check HTTP status of a slow-responding URL
```

## Real-World Scenarios

### Troubleshooting
```
The firewall seems slow, check disk usage and memory on opnsense
```
```
I can't reach prox_big, ping it and check its network interfaces
```
```
Check if opnsense is running out of disk space
```

### Monitoring
```
Show me the current system load on all Proxmox nodes
```
```
Check disk usage across all lab hosts
```
```
Monitor network connectivity to critical services
```

### Maintenance
```
Check which services are running on prox_big
```
```
Show me log file sizes on opnsense
```
```
Check for large files that might need cleanup on yin
```

## Advanced Tests

### Command Substitution (if supported)
```
Check status of nginx service on prox_big
```
```
Show last 50 log entries for systemd service on yin
```
```
Tail the last 100 lines of /var/log/syslog on opnsense
```

### Multiple Hosts
```
Compare disk usage between opnsense and prox_big
```
```
Show uptime for all lab hosts
```
```
Check network interfaces on all Proxmox nodes
```

### Complex Diagnostic Scenarios
```
Diagnose connectivity: ping gateway, then traceroute to external host, then check DNS
```
```
Test full network path: ping each hop from here to 8.8.8.8
```
```
Verify service availability: ping host, check HTTP, then check SSH connectivity
```

## Error Recovery Tests

### Network Failures
```
Ping a host that's currently down
```
```
SSH to a host that's unreachable
```
```
Traceroute through a network that's experiencing issues
```

### Command Failures
```
Run a command that will fail (e.g., cat /nonexistent/file)
```
```
Execute a command with invalid syntax
```
```
Try to access a file without permissions
```

## Boundary Tests

### Empty/Null Inputs
```
Run command on opnsense with empty command string
```
```
Ping with empty target
```

### Very Long Commands
```
Run a very long command string (test command length limits)
```

### Special Characters
```
Run command with special characters in parameters
```
```
Ping a hostname with special characters
```

## Expected Behaviors to Validate

1. **Host Resolution**: Should resolve aliases correctly (opnsense → 172.16.0.1)
2. **Command Validation**: Should reject unapproved commands with helpful suggestions
3. **Error Messages**: Should provide clear, actionable error messages
4. **Timeout Handling**: Should handle long-running commands gracefully
5. **Security**: Should enforce read-only mode and reject dangerous commands
6. **Integration**: Should work seamlessly with other tools (Proxmox, OPNsense)
7. **Performance**: Should handle multiple concurrent requests
8. **Logging**: Should log all SSH operations for audit trail

