# Project Palindrome — Management Guide

Quick reference for common commands and workflows.

## Quick Start

```bash
# Run the agent CLI
bun run src/cli.ts help

# Start interactive REPL
bun run src/cli.ts repl

# Ask a question
bun run src/cli.ts ask "why is the disk so full on opnsense?"
```

## Testing

### Run All Tests
```bash
bun test
```

### Run Specific Test Files
```bash
# Test CLI
bun test tests/cli.test.ts

# Test agent context
bun test tests/agent-context.test.ts

# Test tools
bun test tests/opnsense.test.ts
bun test tests/ssh.test.ts

# Test runner (requires OPENAI_API_KEY)
bun test tests/runner.test.ts
bun test tests/runner-mvs.test.ts
```

### Test Individual Tools via CLI
```bash
# Test OPNsense tool
bun run src/cli.ts opnsense status
bun run src/cli.ts opnsense aliases

# Test SSH tool
bun run src/cli.ts ssh opnsense "du -sh /*"
bun run src/cli.ts ssh 172.16.0.1 "uptime"
```

> Direct CLI calls now run through the same ACL + confirmation guardrails as the agent runtime. Set `PCE_ACL_GROUP`/`PCE_USER_ID` to match the desired role, and expect a confirmation prompt for any tool that declares `requiresConfirmation` (e.g., `proxmox_write`, `opnsense_safewrite`) unless `PCE_AUTO_APPROVE_HIGH_RISK_TOOLS=true` is provided.

## Tool Management

### Export Tool Schemas
```bash
# Export all tool schemas to JSON
bun run export-tools > tools.json

# View exported schemas
cat tools.json | jq '.[0]'  # Pretty print first tool
cat tools.json | jq '.[] | .name'  # List all tool names
```

### Add a New Tool

1. **Create Zod schema** (`src/tools/schemas/my-tool.ts`):
```typescript
import { z } from "zod";

export const MyToolParams = z.object({
  param1: z.string().describe("Description"),
  param2: z.enum(["option1", "option2"]).describe("Description"),
});
```

2. **Implement tool** (`src/tools/MyTool.ts`):
```typescript
import { BaseTool } from "./BaseTool";
import { MyToolParams } from "./schemas/my-tool";
import { createToolSchema } from "./tool-helpers";
import type { ToolSchema } from "./tool-schema";

export class MyTool extends BaseTool {
  constructor() {
    super({
      name: "my_tool",
      description: "What this tool does",
      categories: ["category1"]
    });
  }

  getSchema(): ToolSchema {
    return createToolSchema(this, MyToolParams, {
      examples: [
        { description: "Example", parameters: { param1: "value" } }
      ],
      notes: ["Important note"]
    });
  }

  getParameterSchema() {
    return MyToolParams;
  }

  async execute(params: Record<string, any>, context: ExecutionContext) {
    // Implementation
  }
}
```

3. **Register tool** (`src/agent/tool-loader.ts`):
```typescript
import { MyTool } from "../tools/MyTool";

export function loadTools(): BaseTool[] {
  return [
    // ... existing tools
    new MyTool(),
  ];
}
```

4. **Verify**:
```bash
# Export schemas to verify it appears
bun run export-tools | jq '.[] | select(.name == "my_tool")'

# Test the tool
bun run src/cli.ts ask "use my_tool to do something"
```

## Development

### Environment Setup
```bash
# Copy example env (if exists)
cp .env.example .env

# Edit environment variables
# Required: OPENAI_API_KEY
# Optional: OPENAI_MODEL (default: gpt-4o-mini)
# Optional: OPNSENSE_URL, OPNSENSE_API_KEY, OPNSENSE_API_SECRET
# Optional: SSH_USER, SSH_PASSWORD, SSH_KEY
```

### Run in Development Mode
```bash
# Start REPL for interactive testing
bun run src/cli.ts repl

# Run with streaming (if implemented)
bun run src/cli.ts ask "question" --stream
```

### Check Code Quality
```bash
# Type check (if using tsc)
bun run tsc --noEmit

# Lint (if configured)
bun run lint
```

## Common Workflows

### Debugging Tool Execution
```bash
# Test tool directly (bypasses LLM)
bun run src/cli.ts opnsense status
bun run src/cli.ts ssh opnsense "du -sh /*"

# Check tool schemas
bun run export-tools | jq '.[] | {name, description, parameters}'
```

### Debugging Agent Behavior
```bash
# Run with verbose logging (check src/agent/runner.ts for logger.info calls)
bun run src/cli.ts ask "your question" 2>&1 | grep -E "(Reasoning step|Tool call|LLM response)"

# Test specific scenarios
bun run src/cli.ts ask "why is the disk so full on opnsense?"
bun run src/cli.ts ask "what is the system status?"
```

### Managing SSH Commands
```bash
# View approved commands
cat src/config/approved-commands.yaml

# Add new approved command
# Edit src/config/approved-commands.yaml
# Add command to appropriate host/category

# Test new command
bun run src/cli.ts ssh opnsense "your-new-command"
```

### Managing OPNsense Access
```bash
# Test OPNsense connection
bun run src/cli.ts opnsense status

# List aliases
bun run src/cli.ts opnsense aliases

# Check environment variables
echo $OPNSENSE_URL
echo $OPNSENSE_API_KEY  # (will show if set)
```

## Troubleshooting

### Agent Not Responding
```bash
# Check OpenAI API key
echo $OPENAI_API_KEY

# Test basic agent
bun run src/cli.ts ask "hello"

# Check logs for errors
bun run src/cli.ts ask "test" 2>&1 | grep -i error
```

### Tool Not Found
```bash
# Verify tool is registered
grep -r "new.*Tool()" src/agent/tool-loader.ts

# Check tool schema export
bun run export-tools | jq '.[] | .name'

# Verify tool file exists
ls src/tools/*Tool.ts
```

### SSH Connection Issues
```bash
# Test SSH manually
ssh root@172.16.0.1

# Check SSH credentials in .env
grep SSH .env

# Test via tool
bun run src/cli.ts ssh opnsense "uptime"

# Check approved commands
cat src/config/approved-commands.yaml | grep -A 10 "172.16.0.1"
```

### OPNsense API Issues
```bash
# Test API connection
bun run src/cli.ts opnsense status

# Check environment variables
grep OPNSENSE .env

# Verify SSL settings
echo $OPNSENSE_VERIFY_SSL
```

## Maintenance

### Update Dependencies
```bash
# Update all dependencies
bun update

# Update specific package
bun update openai

# Check outdated packages
bun outdated
```

### Clean Build Artifacts
```bash
# Remove node_modules (if needed)
rm -rf node_modules
bun install

# Clear Bun cache
rm -rf .bun
```

### Backup Configuration
```bash
# Backup important configs
cp src/config/approved-commands.yaml src/config/approved-commands.yaml.backup
cp .env .env.backup
```

## Monitoring & Logs

### View Agent Logs
```bash
# All logs
bun run src/cli.ts ask "question" 2>&1

# Only info logs
bun run src/cli.ts ask "question" 2>&1 | grep "\[info\]"

# Only errors
bun run src/cli.ts ask "question" 2>&1 | grep "\[error\]"

# Tool execution logs
bun run src/cli.ts ask "question" 2>&1 | grep -E "(Executing tool|Tool call detected)"
```

### Performance Monitoring
```bash
# Check tool execution times (durationMs in tool results)
bun run src/cli.ts ask "question" 2>&1 | grep "durationMs"

# Monitor reasoning steps
bun run src/cli.ts ask "question" 2>&1 | grep "Reasoning step"
```

## Security

### Check for Sensitive Data Leakage
```bash
# Review sanitization
cat src/utils/sanitize.ts

# Test tool output sanitization
bun run src/cli.ts ssh opnsense "du -sh /*" | grep -i "password\|secret\|key"

# Review security docs
cat docs/security-openai-api.md
```

### Audit Environment Variables
```bash
# List all env vars (be careful with secrets)
env | grep -E "(OPENAI|OPNSENSE|SSH)" | sed 's/=.*/=***/'

# Check .env file (don't commit!)
cat .env | grep -v "^#" | grep -v "^$"
```

## Documentation

### Generate Documentation
```bash
# View tool schemas
bun run export-tools | jq

# View system prompt (generated)
# Check src/agent/system-prompt.ts

# View available docs
ls docs/
```

### Update Documentation
```bash
# Tool schemas auto-update when you run export-tools
bun run export-tools > tools.json

# System prompt auto-updates when tools are added
# No manual update needed
```

## Git Workflow

### Before Committing
```bash
# Run tests
bun test

# Export tool schemas
bun run export-tools > tools.json

# Check for sensitive data
git diff | grep -i "password\|secret\|key" | grep -v "REDACTED"
```

### Common Git Commands
```bash
# Check status
git status

# View changes
git diff

# Stage changes
git add .

# Commit
git commit -m "Description of changes"

# Push
git push
```

## Advanced

### Custom Model Selection
```bash
# Use gpt-4o for better reasoning
export OPENAI_MODEL=gpt-4o
bun run src/cli.ts ask "complex question"

# Use gpt-4o-mini for cost savings (default)
export OPENAI_MODEL=gpt-4o-mini
bun run src/cli.ts ask "simple question"
```

### Debug Tool Schema Generation
```bash
# Export and inspect
bun run export-tools | jq '.[0] | .parameters'

# Check Zod schema conversion
# Inspect src/tools/tool-schema.ts zodToJsonSchema function
```

### Profile Performance
```bash
# Time agent execution
time bun run src/cli.ts ask "question"

# Count reasoning steps
bun run src/cli.ts ask "question" 2>&1 | grep "Reasoning step" | wc -l
```

## Quick Reference

| Task | Command |
|------|---------|
| Run tests | `bun test` |
| Start REPL | `bun run src/cli.ts repl` |
| Ask question | `bun run src/cli.ts ask "question"` |
| Export tools | `bun run export-tools > tools.json` |
| Test OPNsense | `bun run src/cli.ts opnsense status` |
| Test SSH | `bun run src/cli.ts ssh opnsense "command"` |
| View logs | `bun run src/cli.ts ask "q" 2>&1 \| grep "\[info\]"` |

## Getting Help

- **Tool Issues**: Check `docs/self-describing-tools.md`
- **SSH Setup**: Check `docs/opnsense-ssh-setup.md`
- **Security**: Check `docs/security-openai-api.md`
- **Architecture**: Check `docs/self-describing-tools.md`

