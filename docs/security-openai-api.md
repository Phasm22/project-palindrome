# Security: OpenAI API Data Leakage Prevention

## What Data is Sent to OpenAI

The agent sends the following to OpenAI's API:

1. **System Prompt**: Contains tool descriptions and reasoning instructions (no sensitive data)
2. **User Messages**: User queries (may contain sensitive info if user types it)
3. **Assistant Messages**: LLM responses
4. **Tool Results**: Output from tools (SSH commands, OPNsense API responses, etc.)

## Potential Security Risks

### ✅ Protected (NOT sent to OpenAI)
- **API Keys**: `OPNSENSE_API_KEY`, `OPNSENSE_API_SECRET` - only used locally
- **SSH Credentials**: `SSH_USER`, `SSH_PASSWORD`, `SSH_KEY` - only used locally
- **Environment Variables**: All credentials stay in `.env` file, never in code

### ⚠️ Potential Leaks (Now Protected)
- **SSH Command Output**: May contain file contents, usernames, paths, system info
- **OPNsense API Responses**: May contain internal IPs, hostnames, configuration details
- **File Paths**: May contain usernames (e.g., `/home/username/`)
- **Long Alphanumeric Strings**: Could be API keys or tokens in output

## Protection Mechanisms

### 1. Sanitization Layer (`src/utils/sanitize.ts`)

All tool results are sanitized before being sent to OpenAI:

- **Sensitive Keys**: Fields with names like `password`, `secret`, `key`, `token`, `credential`, `auth`, `private` are redacted
- **API Keys**: Long hex/base64-like strings (32+ chars) are redacted
- **Tokens**: Base64-like strings (40+ chars) are redacted
- **User Paths**: `/home/[username]/` and `/Users/[username]/` are replaced with `/home/[USER]/` and `/Users/[USER]/`

### 2. Tool-Specific Sanitization

- **SSH Tool**: Sanitizes `stdout` and `stderr` output
- **OPNsense Tool**: Sanitizes all response data
- **Glances Tool**: Sanitizes system metrics (less sensitive, but still sanitized)

## What Could Still Leak

Even with sanitization, the following might still be sent:

1. **Internal IP Addresses**: `172.16.0.1`, `192.168.x.x` (may be in tool results)
2. **Hostnames**: System hostnames from SSH/OPNsense responses
3. **File Paths**: Non-user paths like `/var/log/`, `/usr/bin/`
4. **System Information**: Disk usage, process info, etc.
5. **User Queries**: If user types sensitive info in their question, it will be sent

## Recommendations

1. **Review Tool Outputs**: Periodically check what data tools return
2. **User Education**: Don't type sensitive information in queries
3. **Network Isolation**: Consider using OpenAI's API with data processing disabled (if available)
4. **Logging**: Be aware that OpenAI may log API requests (check their privacy policy)
5. **Custom Sanitization**: Add more specific patterns to `sanitize.ts` if you find sensitive data in outputs

## Testing Sanitization

To test if sanitization is working:

```bash
# Check what's actually sent (add logging in context.ts)
bun run src/cli.ts ask "test query"
```

## Future Improvements

- [ ] Add configurable sanitization rules
- [ ] Add audit logging of what's sent to OpenAI
- [ ] Add option to disable sending tool results (summary only)
- [ ] Add IP address redaction for internal networks
- [ ] Add hostname redaction

