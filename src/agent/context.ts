import { sanitizeToolResult } from "../utils/sanitize";

export class AgentContext {
  private messages: { role: string; content: string }[] = [];

  addUserMessage(msg: string) {
    this.messages.push({ role: "user", content: msg });
  }

  addAssistantMessage(msg: string) {
    this.messages.push({ role: "assistant", content: msg });
  }

  addToolResult(toolName: string, data: any) {
    // Sanitize tool results before sending to LLM to prevent sensitive data leakage
    const sanitized = sanitizeToolResult(toolName, data);
    
    let content = `Tool "${toolName}" returned:\n`;
    
    if (sanitized.error) {
      content += `ERROR: ${sanitized.error}`;
      if (sanitized.note) {
        content += `\nNOTE: ${sanitized.note}`;
      }
    } else {
      const dataStr = typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
      content += dataStr.slice(0, 2000); // Increased limit to show more data
    }
    
    this.messages.push({
      role: "assistant",
      content
    });
  }

  getMessages() {
    return this.messages;
  }

  clear() {
    this.messages = [];
  }
}

