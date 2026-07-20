import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  ApplicationLifecycleExecutor,
  FileLifecycleJournal,
  MemoryLifecycleJournal,
  type LifecycleHandlerRegistry,
} from "../../src/actions/applications/lifecycle-executor";
import { compileApplicationLifecycle } from "../../src/actions/applications/lifecycle-compiler";
import { makeApplicationManifest } from "./fixtures/application-manifest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

function createHandlers(events: string[]): LifecycleHandlerRegistry {
  const handler = (kind: string) => ({
    async execute({ step }: any) {
      events.push(`start:${step.id}`);
      await Promise.resolve();
      events.push(`done:${step.id}`);
      return { kind, stepId: step.id };
    },
    async compensate({ step }: any) {
      events.push(`rollback:${step.id}`);
    },
  });

  return {
    "reserve-vm": handler("reserve-vm"),
    "create-vm": handler("create-vm"),
    "wait-for-ssh": handler("wait-for-ssh"),
    "configure-services": handler("configure-services"),
    "deploy-assets": handler("deploy-assets"),
    "configure-firewall": handler("configure-firewall"),
    "create-dns": handler("create-dns"),
    "publish-application": handler("publish-application"),
    "verify-application": handler("verify-application"),
    "unpublish-application": handler("unpublish-application"),
    "destroy-vm": handler("destroy-vm"),
    "verify-removal": handler("verify-removal"),
  };
}

describe("ApplicationLifecycleExecutor", () => {
  test("executes the compiled dependency graph", async () => {
    const events: string[] = [];
    const plan = compileApplicationLifecycle(makeApplicationManifest());
    const executor = new ApplicationLifecycleExecutor(createHandlers(events), {
      maxConcurrency: 4,
    });

    const result = await executor.execute(plan);

    expect(result.success).toBe(true);
    expect(result.completedSteps).toHaveLength(plan.steps.length);
    expect(events.indexOf("done:stark:stark:create")).toBeLessThan(
      events.indexOf("start:stark:stark:wait-ssh")
    );
    expect(events.indexOf("done:stark:publish")).toBeLessThan(
      events.indexOf("start:stark:verify")
    );
  });

  test("rolls back compensatable completed steps after failure", async () => {
    const events: string[] = [];
    const handlers = createHandlers(events);
    handlers["configure-firewall"] = {
      async execute() {
        throw new Error("firewall failed");
      },
    };
    const plan = compileApplicationLifecycle(makeApplicationManifest());
    const executor = new ApplicationLifecycleExecutor(handlers);

    const result = await executor.execute(plan);

    expect(result.success).toBe(false);
    expect(result.error).toBe("firewall failed");
    expect(result.rolledBackSteps).toContain("stark:stark:create");
    expect(events).toContain("rollback:stark:stark:create");
  });

  test("skips already completed idempotent steps", async () => {
    const events: string[] = [];
    const journal = new MemoryLifecycleJournal();
    const plan = compileApplicationLifecycle(makeApplicationManifest());
    const first = new ApplicationLifecycleExecutor(createHandlers(events), {
      journal,
    });
    expect((await first.execute(plan)).success).toBe(true);

    events.length = 0;
    const second = new ApplicationLifecycleExecutor(createHandlers(events), {
      journal,
    });
    const result = await second.execute(plan);

    expect(result.success).toBe(true);
    expect(events).toEqual([]);
  });

  test("reruns steps when a request ID is reused with a changed manifest", async () => {
    const events: string[] = [];
    const journal = new MemoryLifecycleJournal();
    const original = makeApplicationManifest();
    const firstPlan = compileApplicationLifecycle(original);
    const first = new ApplicationLifecycleExecutor(createHandlers(events), {
      journal,
    });
    expect((await first.execute(firstPlan)).success).toBe(true);

    events.length = 0;
    const changed = structuredClone(original);
    changed.applications[0]!.description = "Changed application description";
    const secondPlan = compileApplicationLifecycle(changed);
    const second = new ApplicationLifecycleExecutor(createHandlers(events), {
      journal,
    });
    expect((await second.execute(secondPlan)).success).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(secondPlan.steps[0]?.idempotencyKey).not.toBe(
      firstPlan.steps[0]?.idempotencyKey
    );
  });

  test("persists journals without using request IDs as paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "palindrome-journal-"));
    temporaryDirectories.push(directory);
    const journal = new FileLifecycleJournal(directory);

    await journal.set("../unsafe-request", {
      stepId: "app:publish",
      idempotencyKey: "key-1",
      status: "succeeded",
      result: { ok: true },
    });

    const entry = await journal.get("../unsafe-request", "app:publish");
    expect(entry?.status).toBe("succeeded");
    expect(
      await readFile(join(directory, "..", "unsafe-request"), "utf-8").catch(
        () => null
      )
    ).toBeNull();
  });
});
