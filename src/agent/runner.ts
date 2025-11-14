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
  try {
    const parsed = JSON.parse(text);
    if (parsed.tool && parsed.parameters) {
      return { tool: parsed.tool, parameters: parsed.parameters };
    }
  } catch (_) {
    // Not JSON or not a tool call
  }
  return null;
}

async function callLLM(messages: { role: string; content: string }[]): Promise<string> {
  const openai = getOpenAIClient();
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
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
  const MAX_STEPS = 5;

  if (stream) {
    // Streaming mode: simplified single-shot for now
    const openai = getOpenAIClient();
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
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
    const toolRequest = isToolRequest(llmResponse);

    if (toolRequest) {
      logger.info(`Tool call detected: ${toolRequest.tool}`);
      const result = await executeToolCall(
        { toolName: toolRequest.tool, parameters: toolRequest.parameters },
        tools
      );

      if (result.error) {
        context.addToolResult(toolRequest.tool, { error: result.error });
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

