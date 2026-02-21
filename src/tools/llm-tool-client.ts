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
  options?: { temperature?: number; maxTokens?: number; timeoutMs?: number }
): Promise<string> {
  const client = getToolOpenAIClient();
  const timeoutMs = options?.timeoutMs ?? 12_000;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let response: Awaited<ReturnType<typeof client.chat.completions.create>>;
  try {
    response = await client.chat.completions.create(
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: options?.temperature ?? 0.2,
        max_tokens: options?.maxTokens ?? 600,
      },
      {
        signal: controller.signal,
      }
    );
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`LLM tool completion timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }

  const content = response.choices[0]?.message?.content?.trim();
  if (!content) {
    pceLogger.warn("LLM tool returned empty content");
    return "";
  }
  return content;
}
