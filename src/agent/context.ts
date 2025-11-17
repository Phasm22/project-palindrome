type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: any[] }
  | { role: "tool"; content: string; tool_call_id: string; name: string };

export class AgentContext {
  private messages: AgentMessage[] = [];

  addUserMessage(msg: string) {
    this.messages.push({ role: "user", content: msg });
  }

  addAssistantMessage(msg: string) {
    this.messages.push({ role: "assistant", content: msg });
  }

  addToolResult(toolCallId: string, toolName: string, data: any) {
    const dataStr = typeof data === "string" ? data : JSON.stringify(data);
    this.messages.push({
      role: "tool",
      content: dataStr.slice(0, 4000),
      tool_call_id: toolCallId,
      name: toolName,
    });
  }

  getMessages() {
    return this.messages;
  }

  clear() {
    this.messages = [];
  }
}

