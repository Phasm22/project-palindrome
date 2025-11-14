import type { ToolCall } from "./tool";

export type AgentResponse = {
  text?: string;
  toolCall?: ToolCall;
};

