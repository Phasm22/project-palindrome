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
 * Install Nginx Action Schema
 */
export const InstallNginxSchema = z.object({
  vmName: z.string().min(1, "VM name is required"),
  waitForVm: z.boolean().default(true),
  timeout: z.number().int().positive().default(300),
  extraVars: z.record(z.string(), z.any()).optional(),
  retryOnFailure: z.boolean().default(false),
  maxRetries: z.number().int().positive().default(1),
  dryRun: z.boolean().default(false),
});

export type InstallNginxParams = z.infer<typeof InstallNginxSchema>;

export interface InstallNginxResult {
  success: boolean;
  vmName: string;
  hostname: string;
  changed: boolean;
  failed: boolean;
  stdout: string;
  stderr: string;
  duration: number;
  message: string;
  errors?: string[];
}

/**
 * Install Nginx Action
 * 
 * Installs and configures nginx on a VM using Ansible.
 * Uses ad-hoc commands if no playbook exists.
 */
export async function installNginx(params: InstallNginxParams): Promise<InstallNginxResult> {
  const startTime = Date.now();
  const {
    vmName,
    waitForVm,
    timeout,
    extraVars,
    retryOnFailure,
    maxRetries,
    dryRun,
  } = params;

  logger.info("Install Nginx action started", { vmName, dryRun });

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
        changed: false,
        failed: true,
        stdout: "",
        stderr: "",
        duration: Date.now() - startTime,
        message: `VM "${resolvedVmName}" is not running. Please start the VM before installing nginx.`,
        errors: ["VM is not in running state"],
      };
    }

    // 3. Ensure hostname is in inventory
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
          changed: false,
          failed: true,
          stdout: "",
          stderr: "",
          duration: Date.now() - startTime,
          message: `VM "${hostname}" is not SSH-accessible after ${timeout} seconds.`,
          errors: [`SSH timeout after ${timeout} seconds`],
        };
      }
    }

    // 5. Install nginx using ad-hoc Ansible commands
    const ansibleRunner = new AnsibleRunner(ansibleDir);
    let lastResult: any = null;
    let attempt = 0;
    let success = false;

    if (dryRun) {
      logger.info("Dry-run: Would install nginx", { hostname });
      return {
        success: true,
        vmName: resolvedVmName,
        hostname,
        changed: false,
        failed: false,
        stdout: "",
        stderr: "",
        duration: Date.now() - startTime,
        message: `Dry-run: Would install nginx on ${hostname}`,
      };
    }

    while (attempt <= maxRetries && !success) {
      attempt++;
      
      if (attempt > 1) {
        logger.info("Retrying nginx installation", { vmName, hostname, attempt, maxRetries });
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      // Use ad-hoc ansible commands to install nginx
      const commands = [
        {
          module: "apt",
          args: { name: "nginx", state: "present", update_cache: "yes" },
          description: "Install nginx package",
        },
        {
          module: "systemd",
          args: { name: "nginx", state: "started", enabled: "yes" },
          description: "Start and enable nginx service",
        },
      ];

      const results: string[] = [];
      const errors: string[] = [];
      let changed = false;

      for (const cmd of commands) {
        try {
          const result = await ansibleRunner.runAdHoc(
            hostname,
            cmd.module,
            cmd.args,
            "inventory.ini"
          );
          
          results.push(`[${cmd.description}] ${result.stdout}`);
          if (result.stderr) {
            errors.push(`[${cmd.description}] ${result.stderr}`);
          }
          // Check if output indicates changes were made
          if (result.stdout.includes("changed") && !result.stdout.includes("changed=0")) {
            changed = true;
          }
          if (!result.success) {
            // Include actual Ansible output in error for debugging
            const errorDetails = result.stderr || result.stdout || "Unknown error";
            logger.error("Ansible command failed", {
              description: cmd.description,
              stdout: result.stdout,
              stderr: result.stderr,
            });
            throw new Error(`Failed to execute: ${cmd.description}\nAnsible output:\n${errorDetails}`);
          }
        } catch (error: any) {
          errors.push(`[${cmd.description}] ${error.message}`);
          throw error;
        }
      }

      success = true;
      const duration = Date.now() - startTime;

      logger.info("Nginx installation completed successfully", {
        vmName: resolvedVmName,
        hostname,
        changed,
        duration,
      });

      return {
        success: true,
        vmName: resolvedVmName,
        hostname,
        changed,
        failed: false,
        stdout: results.join("\n"),
        stderr: errors.join("\n"),
        duration,
        message: `Nginx installed successfully on ${hostname}. Service is running and enabled.`,
      };
    }

    // Failed after all retries
    const duration = Date.now() - startTime;
    logger.error("Nginx installation failed", {
      vmName: resolvedVmName,
      hostname,
      attempts: attempt,
    });

    return {
      success: false,
      vmName: resolvedVmName,
      hostname,
      changed: false,
      failed: true,
      stdout: lastResult?.stdout || "",
      stderr: lastResult?.stderr || "",
      duration,
      message: `Nginx installation failed on ${hostname} after ${attempt} attempt(s).`,
      errors: [lastResult?.stderr || "Unknown error"],
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    logger.error("Install Nginx action error", {
      vmName,
      error: error.message,
      stack: error.stack,
    });

    return {
      success: false,
      vmName,
      hostname: vmName,
      changed: false,
      failed: true,
      stdout: "",
      stderr: error.message,
      duration,
      message: `Nginx installation failed: ${error.message}`,
      errors: [error.message],
    };
  }
}
