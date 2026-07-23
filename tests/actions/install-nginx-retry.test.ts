import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
  type Mock,
} from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { installNginx } from "../../src/actions/services/install-nginx";
import { AnsibleRunner } from "../../src/actions/helpers/ansible-runner";
import { TwinQueryService } from "../../src/twin/api/twin-query-service";

describe("installNginx retry behavior", () => {
  let ansibleDir: string;
  let previousAnsibleDir: string | undefined;
  let runAdHocSpy: Mock<any>;
  let findVmSpy: Mock<any>;
  let setTimeoutSpy: Mock<any>;

  beforeEach(async () => {
    ansibleDir = await mkdtemp(join(tmpdir(), "install-nginx-retry-"));
    await writeFile(join(ansibleDir, "inventory.ini"), "retry-test.prox\n");
    previousAnsibleDir = process.env.ANSIBLE_DIR;
    process.env.ANSIBLE_DIR = ansibleDir;

    findVmSpy = spyOn(TwinQueryService.prototype, "findVmByName").mockResolvedValue([
      { name: "retry-test", state: "running" } as any,
    ]);

    let aptAttempts = 0;
    runAdHocSpy = spyOn(AnsibleRunner.prototype, "runAdHoc").mockImplementation(
      async (_host, module) => {
        if (module === "apt" && ++aptAttempts === 1) {
          return { success: false, stdout: "", stderr: "temporary failure" };
        }
        return { success: true, stdout: "changed=1", stderr: "" };
      }
    );

    setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
      ((callback: (...args: any[]) => void) => {
        callback();
        return 0 as any;
      }) as typeof setTimeout
    );
  });

  afterEach(async () => {
    runAdHocSpy.mockRestore();
    findVmSpy.mockRestore();
    setTimeoutSpy.mockRestore();
    if (previousAnsibleDir === undefined) {
      delete process.env.ANSIBLE_DIR;
    } else {
      process.env.ANSIBLE_DIR = previousAnsibleDir;
    }
    await rm(ansibleDir, { recursive: true, force: true });
  });

  test("retries a failed command and succeeds on the second attempt", async () => {
    const result = await installNginx({
      vmName: "retry-test.prox",
      waitForVm: false,
      timeout: 1,
      retryOnFailure: true,
      maxRetries: 2,
      dryRun: false,
    });

    expect(result.success).toBe(true);
    expect(
      runAdHocSpy.mock.calls.filter(([, module]) => module === "apt")
    ).toHaveLength(2);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });
});
