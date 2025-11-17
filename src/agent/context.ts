export class AgentContext {
  private messages: { role: string; content: string }[] = [];

  addUserMessage(msg: string) {
    this.messages.push({ role: "user", content: msg });
  }

  addAssistantMessage(msg: string) {
    this.messages.push({ role: "assistant", content: msg });
  }

  addToolResult(toolName: string, data: any) {
    let content = `Tool "${toolName}" returned:\n`;
    
    if (data.error) {
      content += `ERROR: ${data.error}`;
      if (data.note) {
        content += `\nNOTE: ${data.note}`;
      }
    } else {
      const dataStr = typeof data === "string" ? data : JSON.stringify(data);
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

