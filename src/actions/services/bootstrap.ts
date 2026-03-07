import { z } from "zod";
import { pceLogger as logger } from "../../pce/utils/logger";
import { AnsibleRunner } from "../helpers/ansible-runner";
import {
  resolveVmToHostname,
  ensureHostnameInInventory,
  waitForSshAccessible,
  verifyVmIsRunning,
} from "../helpers/ansible-helpers";

/**
 * Bootstrap Action Schema
 */
export const BootstrapSchema = z.object({
  vmName: z.string().min(1, "VM name is required").describe("VM name to bootstrap (resolved via digital twin to obtain the SSH hostname)"),
  playbook: z.string().default("common.yml").describe("Ansible playbook filename to run (default: 'common.yml')"),
  waitForVm: z.boolean().default(true).describe("Wait for SSH to become accessible before running the playbook (default: true)"),
  timeout: z.number().int().positive().default(300).describe("SSH wait timeout in seconds (default: 300)"),
  extraVars: z.record(z.string(), z.any()).optional().describe("Additional Ansible extra-vars to pass to the playbook (optional)"),
  retryOnFailure: z.boolean().default(false).describe("Retry the playbook on failure (default: false)"),
  maxRetries: z.number().int().positive().default(1).describe("Maximum number of retry attempts when retryOnFailure is true (default: 1)"),
  dryRun: z.boolean().default(false).describe("Preview without executing the playbook (default: false)"),
});

export type BootstrapParams = z.infer<typeof BootstrapSchema>;

export interface BootstrapResult {
  success: boolean;
  vmName: string;
  hostname: string;
  playbook: string;
  changed: boolean;
  failed: boolean;
  tasksChanged?: number;
  tasksFailed?: number;
  stdout: string;
  stderr: string;
  duration: number;
  message: string;
  errors?: string[];
}

/**
 * Bootstrap Action
 * 
 * Runs Ansible playbook (default: common.yml) on a VM to perform
 * complete system setup (security hardening, Docker, etc.)
 */
export async function bootstrap(params: BootstrapParams): Promise<BootstrapResult> {
  const startTime = Date.now();
  const {
    vmName,
    playbook,
    waitForVm,
    timeout,
    extraVars,
    retryOnFailure,
    maxRetries,
    dryRun,
  } = params;

  logger.info("Bootstrap action started", {
    vmName,
    playbook,
    waitForVm,
    timeout,
    dryRun,
  });

  try {
    // 1. Resolve VM name to hostname
    const { hostname, vmName: resolvedVmName } = await resolveVmToHostname(vmName);
    logger.info("Resolved VM to hostname", { vmName, hostname, resolvedVmName });

    // 2. Verify VM is running
    const isRunning = await verifyVmIsRunning(resolvedVmName);
    if (!isRunning) {
      return {
        success: false,
        vmName: resolvedVmName,
        hostname,
        playbook,
        changed: false,
        failed: true,
        stdout: "",
        stderr: "",
        duration: Date.now() - startTime,
        message: `VM "${resolvedVmName}" is not running. Please start the VM before running bootstrap.`,
        errors: ["VM is not in running state"],
      };
    }

    // 3. Ensure hostname is in inventory (hybrid refresh)
    const ansibleDir = process.env.ANSIBLE_DIR || "lab-infra/ansible";
    await ensureHostnameInInventory(hostname, ansibleDir);

    // 4. Wait for SSH accessibility if requested
    if (waitForVm) {
      const isAccessible = await waitForSshAccessible(hostname, ansibleDir, timeout);
      if (!isAccessible) {
        return {
          success: false,
          vmName: resolvedVmName,
          hostname,
          playbook,
          changed: false,
          failed: true,
          stdout: "",
          stderr: "",
          duration: Date.now() - startTime,
          message: `VM "${hostname}" is not SSH-accessible after ${timeout} seconds. ` +
            `Cloud-init may still be running. Please wait and try again.`,
          errors: [`SSH timeout after ${timeout} seconds`],
        };
      }
    }

    // 5. Run playbook with retry logic
    const ansibleRunner = new AnsibleRunner(ansibleDir);
    let lastResult: any = null;
    let attempt = 0;
    let success = false;

    while (attempt <= maxRetries && !success) {
      attempt++;
      
      if (attempt > 1) {
        logger.info("Retrying bootstrap", { vmName, hostname, attempt, maxRetries });
        // Wait a bit before retry
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      if (dryRun) {
        logger.info("Dry-run: Would run playbook", { playbook, hostname });
        return {
          success: true,
          vmName: resolvedVmName,
          hostname,
          playbook,
          changed: false,
          failed: false,
          stdout: "",
          stderr: "",
          duration: Date.now() - startTime,
          message: `Dry-run: Would run playbook "${playbook}" on ${hostname}`,
        };
      }

	  const result = await ansibleRunner.runPlaybook(playbook, "inventory.ini", extraVars, hostname);
      lastResult = result;

      // Parse task counts from output
      const tasksChangedMatch = result.stdout.match(/changed=(\d+)/);
      const tasksFailedMatch = result.stdout.match(/failed=(\d+)/);
      const tasksChangedRaw = tasksChangedMatch?.[1];
      const tasksFailedRaw = tasksFailedMatch?.[1];
      const tasksChanged = tasksChangedRaw ? parseInt(tasksChangedRaw, 10) : 0;
      const tasksFailed = tasksFailedRaw ? parseInt(tasksFailedRaw, 10) : 0;

      // Check if successful
      if (result.success && !result.failed) {
        success = true;
        const duration = Date.now() - startTime;
        
        logger.info("Bootstrap completed successfully", {
          vmName: resolvedVmName,
          hostname,
          playbook,
          tasksChanged,
          tasksFailed,
          duration,
        });

        return {
          success: true,
          vmName: resolvedVmName,
          hostname,
          playbook,
          changed: result.changed,
          failed: false,
          tasksChanged,
          tasksFailed,
          stdout: result.stdout,
          stderr: result.stderr,
          duration,
          message: `Bootstrap completed successfully on ${hostname}. ` +
            `${tasksChanged} task(s) changed, ${tasksFailed} task(s) failed.`,
        };
      }

      // If failed and retry is enabled, continue loop
      if (!retryOnFailure || attempt > maxRetries) {
        break;
      }
    }

    // Failed after all retries
    const duration = Date.now() - startTime;
    const errors = parseAnsibleErrors(lastResult?.stderr || lastResult?.stdout || "");

    logger.error("Bootstrap failed", {
      vmName: resolvedVmName,
      hostname,
      playbook,
      attempts: attempt,
      errors,
    });

    return {
      success: false,
      vmName: resolvedVmName,
      hostname,
      playbook,
      changed: lastResult?.changed || false,
      failed: true,
      tasksChanged: 0,
      tasksFailed: (() => {
        const failedRaw = lastResult?.stdout.match(/failed=(\d+)/)?.[1];
        return failedRaw ? parseInt(failedRaw, 10) : 0;
      })(),
      stdout: lastResult?.stdout || "",
      stderr: lastResult?.stderr || "",
      duration,
      message: `Bootstrap failed on ${hostname} after ${attempt} attempt(s). ` +
        `Check logs for details.`,
      errors,
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    logger.error("Bootstrap action error", {
      vmName,
      error: error.message,
      stack: error.stack,
    });

    return {
      success: false,
      vmName,
      hostname: vmName,
      playbook,
      changed: false,
      failed: true,
      stdout: "",
      stderr: error.message,
      duration,
      message: `Bootstrap failed: ${error.message}`,
      errors: [error.message],
    };
  }
}

/**
 * Parse error messages from Ansible output
 */
function parseAnsibleErrors(output: string): string[] {
  const errors: string[] = [];
  
  // Look for common error patterns
  const errorPatterns = [
    /ERROR! (.+)/g,
    /fatal: (.+)/g,
    /FAILED! (.+)/g,
    /error: (.+)/g,
  ];

  for (const pattern of errorPatterns) {
    const matches = output.matchAll(pattern);
    for (const match of matches) {
      if (match[1] && !errors.includes(match[1])) {
        errors.push(match[1]);
      }
    }
  }

  // If no specific errors found, extract last few lines
  if (errors.length === 0) {
    const lines = output.split("\n").filter(line => line.trim());
    const lastErrorLines = lines.slice(-5);
    if (lastErrorLines.length > 0) {
      errors.push(...lastErrorLines);
    }
  }

  return errors;
}
