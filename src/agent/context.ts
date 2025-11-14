export class AgentContext {
  private messages: { role: string; content: string }[] = [];

  addUserMessage(msg: string) {
    this.messages.push({ role: "user", content: msg });
  }

  addAssistantMessage(msg: string) {
    this.messages.push({ role: "assistant", content: msg });
  }

  addToolResult(toolName: string, data: any) {
    const dataStr = typeof data === "string" ? data : JSON.stringify(data);
    this.messages.push({
      role: "assistant",
      content: `Tool "${toolName}" returned:\n${dataStr.slice(0, 500)}`
    });
  }

  getMessages() {
    return this.messages;
  }

  clear() {
    this.messages = [];
  }
}

