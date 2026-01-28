import OpenAI from "openai";
import { pceLogger } from "../pce/utils/logger";

let openaiClient: OpenAI | null = null;

export function getToolOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable is not set");
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

export async function runToolCompletion(
  systemPrompt: string,
  userPrompt: string,
  options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  const client = getToolOpenAIClient();
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: options?.temperature ?? 0.2,
    max_tokens: options?.maxTokens ?? 600,
  });

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) {
    pceLogger.warn("LLM tool returned empty content");
    return "";
  }
  return content;
}
