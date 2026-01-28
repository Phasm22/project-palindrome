/**
 * Response Formatter
 * 
 * Uses a quick LLM call to format agent responses in a structured, data-oriented style.
 * Transforms verbose LLM responses into concise, bot-like formats similar to:
 * - Firewall rules: "BLOCK | dir=in | src=192.168.71.5 | dst=any"
 * - VM status: structured lists with key metrics
 * - Network info: tabular data formats
 */

import OpenAI from "openai";
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

export interface FormatContext {
  userQuery: string;
  intentType?: string;
  toolCalls?: Array<{ toolName: string; parameters?: Record<string, any> }>;
  rawData?: any; // Optional raw data from tools for context
}

/**
 * Format response using a quick LLM call to make it more structured and data-oriented
 * 
 * This transforms verbose responses into concise, bot-like formats:
 * - Removes unnecessary pleasantries and explanations
 * - Structures data in a consistent format
 * - Uses pipe-separated values for lists (like firewall rules)
 * - Focuses on the data, not the narrative
 */
export async function formatResponseForBot(
  rawResponse: string,
  context: FormatContext
): Promise<string> {
  // Skip formatting if disabled
  if (process.env.DISABLE_RESPONSE_FORMATTING === "true") {
    return rawResponse;
  }

  // Skip formatting for very short responses or clarifications
  if (rawResponse.length < 50 || 
      rawResponse.includes("Could you clarify") || 
      rawResponse.includes("I'm not sure") ||
      rawResponse.includes("Max reasoning depth reached")) {
    return rawResponse;
  }

  // Skip formatting for error messages
  if (rawResponse.toLowerCase().includes("error") && 
      (rawResponse.toLowerCase().includes("failed") || 
       rawResponse.toLowerCase().includes("not found"))) {
    return rawResponse;
  }

  try {
    const client = getOpenAIClient();
    
    // Build context about what tools were used and what data was retrieved
    let toolContext = "";
    if (context.toolCalls && context.toolCalls.length > 0) {
      const toolNames = context.toolCalls.map(tc => tc.toolName).join(", ");
      toolContext = `Tools used: ${toolNames}`;
    }

    // Build intent context
    let intentContext = "";
    if (context.intentType) {
      intentContext = `Intent: ${context.intentType}`;
    }

    const systemPrompt = `You are a response formatter that transforms verbose agent responses into structured, data-oriented formats.

Your goal is to make responses more "bot-like" - concise, structured, and focused on the data.

Guidelines:
1. Remove unnecessary pleasantries, explanations, and narrative text
2. Structure data in consistent formats:
   - Firewall rules: "ACTION | dir=direction | src=source | dst=destination | proto=protocol | if=interface"
   - VM/container lists: Structured lists with key metrics (name, status, resources)
   - Network info: Tabular or pipe-separated formats
   - Status queries: Direct answers with key metrics
3. Use pipe separators (|) for structured data lists
4. Keep only essential information
5. If the response is already well-formatted, return it as-is
6. Preserve any structured data formats that are already present
7. Do NOT add explanations or context - just the data

Example transformations:
- "The firewall has the following rules: BLOCK rule for incoming traffic from 192.168.71.5" 
  → "Firewall Rules\nBLOCK | dir=in | src=192.168.71.5 | dst=any"
  
- "VM 101 is running and has 14.36 GB of memory used out of 16 GB total"
  → "VM 101\nStatus: running\nMemory: 14.36 GB / 16 GB"

- "Here are the nodes in the cluster: prox_big, yin, yang"
  → "Cluster Nodes\n- prox_big\n- yin\n- yang"`;

    const userPrompt = `Original response to format:
${rawResponse}

${intentContext ? `${intentContext}\n` : ""}${toolContext ? `${toolContext}\n` : ""}
User query: "${context.userQuery}"

Format this response in a structured, data-oriented style. Return only the formatted response, no explanations.`;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini", // Use fast, cheap model for formatting
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1, // Low temperature for consistent formatting
      max_tokens: 2000, // Should be enough for formatted responses
    });

    const formatted = response.choices[0]?.message?.content?.trim() || rawResponse;
    
    logger.debug("Response formatted", {
      originalLength: rawResponse.length,
      formattedLength: formatted.length,
      intentType: context.intentType,
    });

    return formatted;
  } catch (error: any) {
    // If formatting fails, return original response
    logger.warn("Response formatting failed, returning original", {
      error: error.message,
    });
    return rawResponse;
  }
}

/**
 * Quick intent detection for response formatting
 * Helps the formatter understand what kind of data it's formatting
 */
export function detectResponseIntent(
  userQuery: string,
  toolCalls?: Array<{ toolName: string; parameters?: Record<string, any> }>
): string | undefined {
  const query = userQuery.toLowerCase();
  
  // Check tool calls first (most reliable)
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      if (tc.toolName === "twin_query" || tc.toolName === "opnsense_readonly") {
        const op = tc.parameters?.operation || tc.parameters?.action || "";
        if (op.includes("firewall")) return "firewall_rules";
        if (op.includes("temperature") || op.includes("temp")) return "temperature";
        if (op.includes("vm") || op.includes("container")) return "compute_status";
        if (op.includes("network") || op.includes("interface")) return "network_info";
      }
      if (tc.toolName === "proxmox_readonly") {
        const action = tc.parameters?.action || "";
        if (action.includes("list_vms") || action.includes("list_containers")) return "compute_list";
        if (action.includes("node") || action.includes("cluster")) return "cluster_status";
      }
    }
  }
  
  // Fallback to query analysis
  if (query.includes("firewall") || query.includes("rule")) return "firewall_rules";
  if (query.includes("temperature") || query.includes("temp")) return "temperature";
  if (query.includes("vm") || query.includes("container")) return "compute_status";
  if (query.includes("network") || query.includes("interface") || query.includes("subnet")) return "network_info";
  if (query.includes("status") || query.includes("uptime")) return "status";
  if (query.includes("list") || query.includes("show")) return "list";
  
  return undefined;
}
