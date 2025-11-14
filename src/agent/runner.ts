import OpenAI from "openai";
import type { AgentResponse } from "../types/agent";
import { logger } from "../utils/logger";

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

export async function runAgent(userInput: string, stream: boolean = false): Promise<AgentResponse> {
  logger.info(`Agent received input: "${userInput}"`);

  const openai = getOpenAIClient();
  
  if (stream) {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are the Project Palindrome agent." },
        { role: "user", content: userInput }
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

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini", // lightweight model
    messages: [
      { role: "system", content: "You are the Project Palindrome agent." },
      { role: "user", content: userInput }
    ],
  });

  const text = response.choices[0]?.message?.content ?? "No response.";

  return { text };
}

