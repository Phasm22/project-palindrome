import { createHash } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type {
  LifecyclePlan,
  LifecycleStep,
  LifecycleStepKind,
} from "./lifecycle-compiler";

export type LifecycleStepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "rolling_back"
  | "rolled_back"
  | "skipped";

export interface LifecycleJournalEntry {
  stepId: string;
  idempotencyKey: string;
  status: LifecycleStepStatus;
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
  error?: string;
}

export interface LifecycleJournal {
  get(requestId: string, stepId: string): Promise<LifecycleJournalEntry | undefined>;
  set(requestId: string, entry: LifecycleJournalEntry): Promise<void>;
}

export class MemoryLifecycleJournal implements LifecycleJournal {
  private readonly entries = new Map<string, LifecycleJournalEntry>();

  private key(requestId: string, stepId: string): string {
    return `${requestId}:${stepId}`;
  }

  async get(
    requestId: string,
    stepId: string
  ): Promise<LifecycleJournalEntry | undefined> {
    return this.entries.get(this.key(requestId, stepId));
  }

  async set(requestId: string, entry: LifecycleJournalEntry): Promise<void> {
    this.entries.set(this.key(requestId, entry.stepId), { ...entry });
  }

  snapshot(requestId: string): LifecycleJournalEntry[] {
    const prefix = `${requestId}:`;
    return Array.from(this.entries.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([, entry]) => ({ ...entry }));
  }
}

type LifecycleJournalFile = {
  requestId: string;
  entries: Record<string, LifecycleJournalEntry>;
};

export class FileLifecycleJournal implements LifecycleJournal {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory = join(
      process.cwd(),
      ".pce",
      "application-lifecycle"
    )
  ) {}

  private pathFor(requestId: string): string {
    const safeId = createHash("sha256").update(requestId).digest("hex");
    return join(this.directory, `${safeId}.json`);
  }

  private async read(requestId: string): Promise<LifecycleJournalFile> {
    const path = this.pathFor(requestId);
    try {
      const content = await readFile(path, "utf-8");
      const parsed = JSON.parse(content) as LifecycleJournalFile;
      if (
        parsed.requestId !== requestId ||
        !parsed.entries ||
        typeof parsed.entries !== "object"
      ) {
        throw new Error(`Invalid lifecycle journal at ${path}`);
      }
      return parsed;
    } catch (error: unknown) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      if (code === "ENOENT") {
        return { requestId, entries: {} };
      }
      throw error;
    }
  }

  async get(
    requestId: string,
    stepId: string
  ): Promise<LifecycleJournalEntry | undefined> {
    const journal = await this.read(requestId);
    return journal.entries[stepId];
  }

  async set(requestId: string, entry: LifecycleJournalEntry): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const path = this.pathFor(requestId);
      await mkdir(dirname(path), { recursive: true });
      const journal = await this.read(requestId);
      journal.entries[entry.stepId] = { ...entry };
      const temporaryPath = `${path}.${process.pid}.tmp`;
      await writeFile(
        temporaryPath,
        `${JSON.stringify(journal, null, 2)}\n`,
        { encoding: "utf-8", mode: 0o600 }
      );
      await rename(temporaryPath, path);
    });

    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }
}

export interface LifecycleHandlerContext {
  plan: LifecyclePlan;
  step: LifecycleStep;
  dependencyResults: Record<string, unknown>;
}

export interface LifecycleHandler {
  execute(context: LifecycleHandlerContext): Promise<unknown>;
  compensate?(context: LifecycleHandlerContext & { result: unknown }): Promise<unknown>;
}

export type LifecycleHandlerRegistry = Partial<
  Record<LifecycleStepKind, LifecycleHandler>
>;

export interface LifecycleExecutionOptions {
  maxConcurrency?: number;
  journal?: LifecycleJournal;
}

export interface LifecycleExecutionResult {
  success: boolean;
  requestId: string;
  completedSteps: string[];
  rolledBackSteps: string[];
  results: Record<string, unknown>;
  error?: string;
  failedStep?: string;
}

type RunningStep = {
  step: LifecycleStep;
  promise: Promise<{ step: LifecycleStep; result?: unknown; error?: Error }>;
};

export class ApplicationLifecycleExecutor {
  private readonly maxConcurrency: number;
  private readonly journal: LifecycleJournal;

  constructor(
    private readonly handlers: LifecycleHandlerRegistry,
    options: LifecycleExecutionOptions = {}
  ) {
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 3);
    this.journal = options.journal ?? new MemoryLifecycleJournal();
  }

  private handlerFor(step: LifecycleStep): LifecycleHandler {
    const handler = this.handlers[step.kind];
    if (!handler) {
      throw new Error(`No lifecycle handler registered for "${step.kind}"`);
    }
    return handler;
  }

  async execute(plan: LifecyclePlan): Promise<LifecycleExecutionResult> {
    const pending = new Map(plan.steps.map((step) => [step.id, step]));
    const completed: LifecycleStep[] = [];
    const results: Record<string, unknown> = {};
    const running = new Map<string, RunningStep>();
    const activeLocks = new Set<string>();
    let failure: { step: LifecycleStep; error: Error } | undefined;

    for (const step of plan.steps) {
      const existing = await this.journal.get(plan.requestId, step.id);
      if (
        existing?.status === "succeeded" &&
        existing.idempotencyKey === step.idempotencyKey
      ) {
        pending.delete(step.id);
        completed.push(step);
        results[step.id] = existing.result;
      }
    }

    const startStep = (step: LifecycleStep): void => {
      pending.delete(step.id);
      if (step.lockKey) activeLocks.add(step.lockKey);

      const promise = (async () => {
        await this.journal.set(plan.requestId, {
          stepId: step.id,
          idempotencyKey: step.idempotencyKey,
          status: "running",
          startedAt: new Date().toISOString(),
        });

        try {
          const dependencyResults = Object.fromEntries(
            step.dependencies.map((dependency) => [
              dependency,
              results[dependency],
            ])
          );
          const result = await this.handlerFor(step).execute({
            plan,
            step,
            dependencyResults,
          });
          return { step, result };
        } catch (error: unknown) {
          return {
            step,
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      })();

      running.set(step.id, { step, promise });
    };

    while ((pending.size > 0 || running.size > 0) && !failure) {
      let scheduled = false;
      for (const step of pending.values()) {
        if (running.size >= this.maxConcurrency) break;
        if (step.lockKey && activeLocks.has(step.lockKey)) continue;
        if (!step.dependencies.every((dependency) => dependency in results)) continue;
        startStep(step);
        scheduled = true;
      }

      if (running.size === 0) {
        if (pending.size > 0) {
          const blocked = Array.from(pending.values())
            .map((step) => `${step.id} <- [${step.dependencies.join(", ")}]`)
            .join("; ");
          failure = {
            step: Array.from(pending.values())[0]!,
            error: new Error(`Lifecycle dependency deadlock: ${blocked}`),
          };
        }
        break;
      }

      if (!scheduled || running.size >= this.maxConcurrency || pending.size === 0) {
        const settled = await Promise.race(
          Array.from(running.values()).map(({ promise }) => promise)
        );
        running.delete(settled.step.id);
        if (settled.step.lockKey) activeLocks.delete(settled.step.lockKey);

        if (settled.error) {
          failure = { step: settled.step, error: settled.error };
          await this.journal.set(plan.requestId, {
            stepId: settled.step.id,
            idempotencyKey: settled.step.idempotencyKey,
            status: "failed",
            completedAt: new Date().toISOString(),
            error: settled.error.message,
          });
        } else {
          results[settled.step.id] = settled.result;
          completed.push(settled.step);
          await this.journal.set(plan.requestId, {
            stepId: settled.step.id,
            idempotencyKey: settled.step.idempotencyKey,
            status: "succeeded",
            completedAt: new Date().toISOString(),
            result: settled.result,
          });
        }
      }
    }

    if (failure && running.size > 0) {
      const remaining = await Promise.all(
        Array.from(running.values()).map(({ promise }) => promise)
      );
      for (const settled of remaining) {
        if (settled.step.lockKey) activeLocks.delete(settled.step.lockKey);
        if (!settled.error) {
          results[settled.step.id] = settled.result;
          completed.push(settled.step);
          await this.journal.set(plan.requestId, {
            stepId: settled.step.id,
            idempotencyKey: settled.step.idempotencyKey,
            status: "succeeded",
            completedAt: new Date().toISOString(),
            result: settled.result,
          });
        }
      }
    }

    if (!failure) {
      return {
        success: true,
        requestId: plan.requestId,
        completedSteps: completed.map((step) => step.id),
        rolledBackSteps: [],
        results,
      };
    }

    const rolledBackSteps: string[] = [];
    if (plan.rollbackPolicy === "automatic") {
      for (const step of [...completed].reverse()) {
        if (!step.compensation) continue;
        const handler = this.handlers[step.kind];
        if (!handler?.compensate) continue;

        await this.journal.set(plan.requestId, {
          stepId: step.id,
          idempotencyKey: step.idempotencyKey,
          status: "rolling_back",
          result: results[step.id],
        });

        try {
          const dependencyResults = Object.fromEntries(
            step.dependencies.map((dependency) => [
              dependency,
              results[dependency],
            ])
          );
          await handler.compensate({
            plan,
            step,
            dependencyResults,
            result: results[step.id],
          });
          rolledBackSteps.push(step.id);
          await this.journal.set(plan.requestId, {
            stepId: step.id,
            idempotencyKey: step.idempotencyKey,
            status: "rolled_back",
            completedAt: new Date().toISOString(),
            result: results[step.id],
          });
        } catch (rollbackError: unknown) {
          const message =
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError);
          await this.journal.set(plan.requestId, {
            stepId: step.id,
            idempotencyKey: step.idempotencyKey,
            status: "failed",
            completedAt: new Date().toISOString(),
            result: results[step.id],
            error: `Rollback failed: ${message}`,
          });
        }
      }
    }

    return {
      success: false,
      requestId: plan.requestId,
      completedSteps: completed.map((step) => step.id),
      rolledBackSteps,
      results,
      error: failure.error.message,
      failedStep: failure.step.id,
    };
  }
}
