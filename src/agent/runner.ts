// Load environment variables
import { config } from "dotenv";
config();

import OpenAI from "openai";
import type { AgentResponse } from "../types/agent";
import { logger } from "../utils/logger";
import { loadTools } from "./tool-loader";
import { executeToolCall } from "./tool-executor";
import { AgentContext } from "./context";
import { SYSTEM_PROMPT } from "./system-prompt";

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

function isToolRequest(text: string): { tool: string; parameters: any } | null {
  // Try to extract JSON from the text (in case LLM adds text before/after JSON)
  const jsonMatch = text.match(/\{[\s\S]*"tool"[\s\S]*"parameters"[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : text;
  
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed.tool && parsed.parameters) {
      let toolName = parsed.tool;
      let parameters = parsed.parameters;
      
      // Handle cases where LLM combines tool name with action (e.g., "opnsense_manage.system_status")
      if (toolName.includes('.')) {
        const parts = toolName.split('.');
        toolName = parts[0]; // Use base tool name
        // If parameters don't have action, extract it from the tool name
        if (!parameters.action && parts.length > 1) {
          parameters = { ...parameters, action: parts[1] };
        }
      }
      
      return { tool: toolName, parameters };
    }
  } catch (_) {
    // Not JSON or not a tool call
  }
  return null;
}

async function callLLM(messages: { role: string; content: string }[]): Promise<string> {
  const openai = getOpenAIClient();
  // Use gpt-4o for better reasoning, or gpt-4o-mini for cost savings
  // gpt-4o-mini: cheaper, faster, but less accurate for complex synthesis
  // gpt-4o: more expensive, but much better at understanding hierarchies and providing accurate summaries
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages
    ],
  });
  return response.choices[0]?.message?.content ?? "No response.";
}

export async function runAgent(userInput: string, stream: boolean = false): Promise<AgentResponse> {
  logger.info(`Agent received input: "${userInput}"`);

  const context = new AgentContext();
  context.addUserMessage(userInput);

  const tools = loadTools();
  const MAX_STEPS = 8; // Increased to allow deeper investigation of multiple directories

  if (stream) {
    // Streaming mode: simplified single-shot for now
    const openai = getOpenAIClient();
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...context.getMessages()
      ],
      stream: true,
    });

    let fullText = "";

    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        process.stdout.write(delta);
      }
    }
    console.log("\n");

    return { text: fullText };
  }

  // Iterative reasoning loop
  for (let step = 0; step < MAX_STEPS; step++) {
    logger.info(`Reasoning step ${step + 1}/${MAX_STEPS}`);

    const llmResponse = await callLLM(context.getMessages());
    logger.info(`LLM response (step ${step + 1}): ${llmResponse.substring(0, 200)}`);
    
    // If LLM is just describing tool results, treat it as needing to continue
    if (llmResponse.trim().startsWith('Tool "') && llmResponse.includes('returned:')) {
      logger.info("LLM is describing tool results, continuing loop to get final answer");
      // Add the description as assistant message and continue
      context.addAssistantMessage(llmResponse);
      continue;
    }
    
    // If LLM says it will investigate but doesn't make a tool call, prompt it to actually do it
    const investigationPhrases = [
      "I need to look",
      "I'll check",
      "Let's get",
      "let's explore",
      "let's check",
      "I should investigate",
      "I will investigate",
      "I will now investigate",
      "I will analyze",
      "I will examine",
      "I will check",
      "need to investigate",
      "should investigate",
      "will analyze",
      "will examine",
      "will check",
      "to determine",
      "to find out",
      "to identify",
      "to explore",
      "within the",
      "what's consuming",
      "what is consuming"
    ];
    const saysWillInvestigate = investigationPhrases.some(phrase => 
      llmResponse.toLowerCase().includes(phrase.toLowerCase())
    );
    const toolRequest = isToolRequest(llmResponse);
    
    if (saysWillInvestigate && !toolRequest) {
      logger.info("LLM says it will investigate but didn't make a tool call, prompting it to actually do it");
      context.addAssistantMessage(llmResponse);
      context.addUserMessage("You said you would investigate further. Please make a tool call NOW to gather the information you need. Don't just describe what you'll do - actually call the tool with JSON format: {\"tool\": \"toolName\", \"parameters\": {...}}");
      continue;
    }

    if (toolRequest) {
      logger.info(`Tool call detected: ${toolRequest.tool}`);
      const result = await executeToolCall(
        { toolName: toolRequest.tool, parameters: toolRequest.parameters },
        tools
      );

      if (result.error) {
        // Check if it's a persistent error (auth, connection) that won't be fixed by retrying
        const persistentErrors = [
          "authentication methods failed",
          "connection refused",
          "connection timeout",
          "host not found",
          "network is unreachable",
          "forbidden",
          "403",
          "unauthorized",
          "401",
          "permission denied"
        ];
        
        const isPersistentError = persistentErrors.some(err => 
          result.error.toLowerCase().includes(err)
        );
        
        if (isPersistentError && step > 0) {
          // If we've already tried once and it's a persistent error, add context and let LLM know
          let note = "This appears to be a persistent connection/authentication issue. Consider using alternative tools or methods.";
          
          // Suggest MCP tool if direct API failed
          if (toolRequest.tool === "opnsense_manage" && result.error.toLowerCase().includes("forbidden")) {
            note += " Try using the mcp_opnsense tool instead, which may have different permissions.";
          }
          
          context.addToolResult(toolRequest.tool, { 
            error: result.error,
            note
          });
        } else {
          context.addToolResult(toolRequest.tool, { error: result.error });
        }
      } else {
        context.addToolResult(toolRequest.tool, result.data);
      }

      // Continue loop to let LLM reflect on tool result
      continue;
    }

    // Not a tool call - final text response
    context.addAssistantMessage(llmResponse);
    return { text: llmResponse };
  }

  // Max steps reached
  return { text: "Max reasoning depth reached. Please try a simpler query." };
}

