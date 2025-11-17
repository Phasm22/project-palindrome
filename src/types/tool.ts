export type ToolCall = {
  toolName: string;
  parameters: Record<string, any>;
};

export type ToolMetadata = {
  name: string;
  description: string;
  categories?: string[];
  parameters?: Record<string, any>;
  allowedAcls?: string[];
  risk?: "low" | "medium" | "high";
  requiresConfirmation?: boolean;
};

