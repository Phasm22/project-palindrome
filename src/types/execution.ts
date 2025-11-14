export type ExecutionContext = {
  toolName: string;
  startedAt: number;
};

export type ExecutionResult<T = any> = {
  data?: T;
  error?: string;
  durationMs?: number;
};

