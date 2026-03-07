import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ReasoningTraceStore,
  resetReasoningTraceStoreForTests,
  setReasoningTraceStoreForTests,
} from "../../src/pce/api/reasoning-trace-store";
import {
  ToolExecutionStore,
  resetToolExecutionStoreForTests,
  setToolExecutionStoreForTests,
} from "../../src/pce/api/tool-execution-store";

export interface IsolatedObservabilityStores {
  reasoningTraceStore: ReasoningTraceStore;
  toolExecutionStore: ToolExecutionStore;
  cleanup: () => void;
}

export function installIsolatedObservabilityStores(label: string): IsolatedObservabilityStores {
  const tempDir = mkdtempSync(join(tmpdir(), `${label}-`));
  const reasoningTraceStore = new ReasoningTraceStore(join(tempDir, "reasoning-traces.db"));
  const toolExecutionStore = new ToolExecutionStore(join(tempDir, "tool-executions.db"));

  setReasoningTraceStoreForTests(reasoningTraceStore);
  setToolExecutionStoreForTests(toolExecutionStore);

  return {
    reasoningTraceStore,
    toolExecutionStore,
    cleanup: () => {
      resetReasoningTraceStoreForTests();
      resetToolExecutionStoreForTests();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
