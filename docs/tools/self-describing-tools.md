# Self-Describing Tools System

## Overview

Project Palindrome uses a **self-describing tool system** that automatically generates tool descriptions from Zod schemas. This eliminates the need to manually maintain tool documentation in the system prompt.

## How It Works

### 1. Tool Schema Definition

Each tool implements a `getSchema()` method that returns a `ToolSchema` object:

```typescript
getSchema(): ToolSchema {
  return {
    name: this.metadata.name,
    description: this.metadata.description,
    parameters: zodToJsonSchema(MyParams), // Auto-converted from Zod
    examples: [...],
    notes: [...],
    categories: [...]
  };
}
```

### 2. Automatic System Prompt Generation

The system prompt is **automatically generated** from all available tools:

```typescript
// src/agent/system-prompt.ts
const tools = loadTools();
const toolsPrompt = generateToolsPrompt(tools);
```

When you add a new tool, it automatically appears in the system prompt - **no manual updates needed**.

### 3. JSON Schema Export

Tools can be exported as JSON Schema for external discovery:

```bash
bun run src/utils/export-tool-schemas.ts > tools.json
```

This produces a JSON file that other systems (MCP clients, API consumers, etc.) can use to discover available tools.

## Benefits

### ✅ Scalability
- **No manual maintenance**: Add a tool, it automatically appears
- **Type-safe**: Zod schemas ensure parameter validation
- **Self-documenting**: Tools describe themselves

### ✅ Standards-Based
- **JSON Schema**: Compatible with OpenAI Function Calling, MCP, OpenAPI
- **Zod Integration**: Leverages existing validation schemas
- **Exportable**: Can be consumed by external systems

### ✅ Developer Experience
- **Single source of truth**: Zod schema defines both validation and description
- **Examples included**: Tools can provide usage examples
- **Rich metadata**: Categories, notes, descriptions all in one place

## Adding a New Tool

1. **Create Zod schema** (`src/tools/schemas/my-tool.ts`):
```typescript
import { z } from "zod";

export const MyToolParams = z.object({
  param1: z.string().describe("Description of param1"),
  param2: z.enum(["option1", "option2"]).describe("Description of param2"),
});
```

2. **Implement tool** (`src/tools/MyTool.ts`):
```typescript
export class MyTool extends BaseTool {
  constructor() {
    super({
      name: "my_tool",
      description: "What this tool does",
      categories: ["category1", "category2"]
    });
  }

  getSchema(): ToolSchema {
    return {
      name: this.metadata.name,
      description: this.metadata.description,
      parameters: zodToJsonSchema(MyToolParams),
      examples: [
        {
          description: "Example usage",
          parameters: { param1: "value", param2: "option1" }
        }
      ],
      notes: ["Important note about the tool"],
      categories: this.metadata.categories,
    };
  }

  getParameterSchema() {
    return MyToolParams;
  }

  async execute(params: Record<string, any>, context: ExecutionContext) {
    // Tool implementation
  }
}
```

3. **Register tool** (`src/agent/tool-loader.ts`):
```typescript
import { MyTool } from "../tools/MyTool";

export function loadTools(): BaseTool[] {
  return [
    new OpnsenseTool(),
    new SSHTool(),
    new MyTool(), // ← Just add it here
  ];
}
```

**That's it!** The tool automatically appears in:
- System prompt (for the LLM)
- Tool registry (for execution)
- JSON export (for external discovery)

## JSON Schema Format

The exported JSON follows this structure:

```json
{
  "name": "tool_name",
  "description": "What the tool does",
  "parameters": {
    "type": "object",
    "properties": {
      "param1": {
        "type": "string",
        "description": "Parameter description"
      }
    },
    "required": ["param1"]
  },
  "examples": [
    {
      "description": "Example usage",
      "parameters": { "param1": "value" }
    }
  ],
  "notes": ["Important notes"],
  "categories": ["category1"]
}
```

## Integration with Other Systems

### OpenAI Function Calling
The JSON Schema format is compatible with OpenAI's function calling format. You can convert tool schemas to OpenAI function definitions:

```typescript
const openaiFunction = {
  name: schema.name,
  description: schema.description,
  parameters: schema.parameters
};
```

### MCP (Model Context Protocol)
MCP tools use a similar schema format. Your tools can be exposed as MCP tools with minimal conversion.

### OpenAPI/Swagger
The JSON Schema can be embedded in OpenAPI specs for REST API documentation.

## Future Enhancements

- [ ] Tool versioning
- [ ] Tool dependencies
- [ ] Tool permissions/authorization
- [ ] Tool usage analytics
- [ ] Tool deprecation warnings
- [ ] Interactive tool documentation generator

