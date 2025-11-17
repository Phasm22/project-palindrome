import readline from "node:readline";
import OpenAI from "openai";
import type { AgentResponse } from "../types/agent";
import { logger } from "../utils/logger";
import { loadTools } from "./tool-loader";
import { executeToolCall } from "./tool-executor";
import { AgentContext } from "./context";
import { SYSTEM_PROMPT } from "./system-prompt";
import { fetchHybridContext, type HybridApiContext } from "./rag-client";
import { getToolRisk, isToolAuthorized, requiresConfirmation, type ToolSession } from "./tool-policy";

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

function buildToolDefinitions(tools: ReturnType<typeof loadTools>) {
  return tools
    .filter((tool) => !!tool.metadata.parameters)
    .map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.metadata.name,
        description: tool.metadata.description,
        parameters: tool.metadata.parameters as Record<string, any>,
      },
    }));
}

function formatRagSummary(rag: HybridApiContext) {
  const lines: string[] = [];
  const fusion = rag.sTotalScore ?? rag.fusionMetrics?.avgTotalScore ?? null;
  lines.push(`RAG_CONTEXT: queryType=${rag.queryType}`);
  if (fusion !== null) {
    lines.push(`FusionScore=${fusion}`);
  }
  lines.push(`CandidateAnswer=${rag.answer}`);
  const topChunks = rag.context.semanticChunks.slice(0, 3);
  if (topChunks.length) {
    lines.push("TopSemanticChunks:");
    topChunks.forEach((chunk) => {
      lines.push(`- ${chunk.sourcePath} (score=${chunk.score.toFixed(2)}): ${chunk.text.slice(0, 140)}...`);
    });
  }
  if (rag.context.structuralPaths.length) {
    lines.push(`StructuralPaths=${rag.context.structuralPaths.length}`);
  }
  return lines.join("\n");
}

async function defaultConfirmHighRisk(toolName: string): Promise<boolean> {
  if (process.env.PCE_AUTO_APPROVE_HIGH_RISK_TOOLS === "true") {
    return true;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  return await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Approve high-risk tool "${toolName}"? (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

export type AgentRunOptions = {
  stream?: boolean;
  userId?: string;
  aclGroup?: string;
  confirmHighRisk?: (info: { toolName: string; parameters: Record<string, any>; risk: string }) => Promise<boolean>;
  ragBaseUrl?: string;
};

function coerceTextContent(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("");
  }
  return String(content);
}

export async function runAgent(
  userInput: string,
  optionsOrStream?: boolean | AgentRunOptions
): Promise<AgentResponse> {
  const options: AgentRunOptions =
    typeof optionsOrStream === "boolean" ? { stream: optionsOrStream } : optionsOrStream ?? {};

  if (options.stream) {
    logger.warn("Streaming mode is not available with tool orchestration; defaulting to non-streaming mode.");
  }

  logger.info(`Agent received input: "${userInput}"`);

  const session: ToolSession = {
    userId: options.userId ?? "agent-user",
    aclGroup: options.aclGroup ?? "admin",
  };

  const confirmHighRisk = options.confirmHighRisk ?? (async ({ toolName }) => defaultConfirmHighRisk(toolName));

  const context = new AgentContext();
  context.addUserMessage(userInput);

  const tools = loadTools();
  const openaiTools = buildToolDefinitions(tools);
  const ragPayload = await fetchHybridContext(userInput, {
    baseUrl: options.ragBaseUrl,
    userId: session.userId,
    aclGroup: session.aclGroup,
  });

  const ragMessage = ragPayload ? [{ role: "system", content: formatRagSummary(ragPayload) }] : [];
  const MAX_STEPS = 5;
  const client = getOpenAIClient();

  for (let step = 0; step < MAX_STEPS; step++) {
    logger.info(`Reasoning step ${step + 1}/${MAX_STEPS}`);

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...ragMessage,
      ...context.getMessages(),
    ] as any[];

    const request: any = {
      model: "gpt-4o-mini",
      messages,
    };

    if (openaiTools.length > 0) {
      request.tools = openaiTools;
      request.tool_choice = "auto";
    }

    const response = await client.chat.completions.create(request);
    const message = response.choices[0]?.message;

    const toolCalls = ((message?.tool_calls as any[]) ?? []) as Array<any>;
    if (toolCalls.length) {
      for (const toolCall of toolCalls) {
        const fnCall = toolCall.function ?? {};
        const toolName = fnCall.name as string | undefined;
        if (!toolName) continue;
        const targetTool = tools.find((t) => t.metadata.name === toolName);
        const provenanceId = `tool://${toolName}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        let parsedArgs: Record<string, any> = {};
        try {
          parsedArgs = fnCall.arguments ? JSON.parse(fnCall.arguments) : {};
        } catch (error) {
          logger.error(`Failed to parse tool arguments for ${toolName}: ${error}`);
        }

        if (!targetTool) {
          context.addToolResult(toolCall.id, toolName, {
            provenanceId,
            success: false,
            error: "Tool not registered",
          });
          continue;
        }

        if (!isToolAuthorized(targetTool, session)) {
          const errorMsg = `ACL group ${session.aclGroup} is not authorized to run ${toolName}`;
          logger.error(errorMsg);
          context.addToolResult(toolCall.id, toolName, {
            provenanceId,
            success: false,
            error: errorMsg,
          });
          continue;
        }

        if (requiresConfirmation(targetTool)) {
          const approved = await confirmHighRisk({
            toolName,
            parameters: parsedArgs,
            risk: getToolRisk(targetTool),
          });

          if (!approved) {
            context.addToolResult(toolCall.id, toolName, {
              provenanceId,
              success: false,
              error: "High-risk action was not approved",
            });
            continue;
          }
        }

        const result = await executeToolCall(
          { toolName, parameters: parsedArgs },
          tools
        );

        context.addToolResult(toolCall.id, toolName, {
          provenanceId,
          success: !result.error,
          data: result.data,
          error: result.error ?? null,
          durationMs: result.durationMs ?? 0,
        });
      }

      continue;
    }

    const finalText = coerceTextContent(message?.content).trim();
    if (finalText) {
      context.addAssistantMessage(finalText);
      return { text: finalText };
    }
  }

  return { text: "Max reasoning depth reached. Please try a simpler query." };
}

