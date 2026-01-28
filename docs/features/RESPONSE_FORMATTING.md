# Response Formatting Enhancement

## Overview

Added a response formatting system that uses a quick LLM call to transform verbose agent responses into structured, data-oriented, "bot-like" formats.

## What It Does

The response formatter:
1. **Captures intent** from the user query and tool calls
2. **Formats responses** using a quick LLM call (gpt-4o-mini) to make them more structured
3. **Removes verbose explanations** and focuses on the data
4. **Uses consistent formats** like pipe-separated values for lists (similar to firewall rules)

## Example Transformations

### Before (verbose):
```
The firewall has the following rules configured. There is a BLOCK rule for incoming traffic from 192.168.71.5 to any destination. Additionally, there are rules blocking traffic from 172.16.0.1...
```

### After (structured):
```
Firewall Rules
BLOCK | dir=in | src=192.168.71.5 | dst=any
BLOCK | dir=in | src=172.16.0.1 | dst=any
BLOCK | dir=in | src=10.10.31.1 | dst=any
...
```

### Before (verbose):
```
VM 101 is currently running and has 14.36 GB of memory used out of 16 GB total. The CPU usage is moderate.
```

### After (structured):
```
VM 101
Status: running
Memory: 14.36 GB / 16 GB
CPU: moderate
```

## Implementation

### Files Added
- `src/agent/response-formatter.ts` - Core formatting logic

### Files Modified
- `src/agent/runner.ts` - Integrated formatter at all response return points

### Key Functions

1. **`formatResponseForBot()`** - Main formatting function
   - Takes raw response and context (query, intent, tool calls)
   - Uses quick LLM call to reformat
   - Returns structured, data-oriented response

2. **`detectResponseIntent()`** - Intent detection for formatting
   - Analyzes user query and tool calls
   - Returns intent type (firewall_rules, compute_status, network_info, etc.)
   - Helps formatter understand what kind of data to format

## Configuration

### Environment Variables

- `DISABLE_RESPONSE_FORMATTING=true` - Disables formatting (returns original responses)
- Uses existing `OPENAI_API_KEY` for the formatting LLM call

### Model Used

- **gpt-4o-mini** - Fast, cheap model for formatting (temperature: 0.1 for consistency)

## When Formatting Is Applied

Formatting is applied to:
1. ✅ Final LLM responses (after tool execution)
2. ✅ Early return responses (firewall chains, compute chains, etc.)
3. ✅ RAG answers (when RAG provides the answer)

Formatting is **skipped** for:
- ❌ Very short responses (< 50 chars)
- ❌ Clarification requests
- ❌ Error messages
- ❌ When `DISABLE_RESPONSE_FORMATTING=true`

## Benefits

1. **Consistent Structure** - All responses follow similar data-oriented formats
2. **Less Verbose** - Removes unnecessary explanations and pleasantries
3. **Better Readability** - Structured formats are easier to scan
4. **Intent-Aware** - Understands what kind of data is being formatted
5. **Non-Breaking** - Falls back to original response if formatting fails

## Performance

- **Latency**: ~200-500ms additional latency per response (quick LLM call)
- **Cost**: Minimal (uses gpt-4o-mini, very cheap)
- **Reliability**: Gracefully falls back to original response on errors

## Future Enhancements

Potential improvements:
- Cache formatted responses for similar queries
- Use local LLM for formatting (Ollama) to reduce latency/cost
- Add more intent-specific formatting rules
- Support custom formatting templates per intent type
