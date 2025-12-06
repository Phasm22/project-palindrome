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
 * Set Static IP Action Schema
 */
export const SetStaticIpSchema = z.object({
  vmName: z.string().min(1, "VM name is required"),
  ip: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/\d+$/, "IP must be in CIDR format (e.g., 192.168.1.100/24)"),
  gateway: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/, "Gateway must be a valid IP address"),
  dns: z.array(z.string()).default(["8.8.8.8", "8.8.4.4"]),
  interface: z.string().default("eth0"),
  waitForVm: z.boolean().default(true),
  timeout: z.number().int().positive().default(300),
  retryOnFailure: z.boolean().default(false),
  maxRetries: z.number().int().positive().default(1),
  dryRun: z.boolean().default(false),
});

export type SetStaticIpParams = z.infer<typeof SetStaticIpSchema>;

export interface SetStaticIpResult {
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
 * Set Static IP Action
 * 
 * Configures a static IP address on a VM using netplan via Ansible.
 */
export async function setStaticIp(params: SetStaticIpParams): Promise<SetStaticIpResult> {
  const startTime = Date.now();
  const {
    vmName,
    ip,
    gateway,
    dns,
    interface: networkInterface,
    waitForVm,
    timeout,
    retryOnFailure,
    maxRetries,
    dryRun,
  } = params;

  logger.info("Set Static IP action started", { vmName, ip, gateway, interface: networkInterface, dryRun });

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
        message: `VM "${resolvedVmName}" is not running. Please start the VM before setting static IP.`,
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

    // 5. Configure static IP using netplan
    const ansibleRunner = new AnsibleRunner(ansibleDir);
    let lastResult: any = null;
    let attempt = 0;
    let success = false;

    if (dryRun) {
      logger.info("Dry-run: Would set static IP", { hostname, ip, gateway });
      return {
        success: true,
        vmName: resolvedVmName,
        hostname,
        changed: false,
        failed: false,
        stdout: "",
        stderr: "",
        duration: Date.now() - startTime,
        message: `Dry-run: Would set static IP ${ip} with gateway ${gateway} on ${hostname}`,
      };
    }

    // Generate netplan YAML content
    const netplanYaml = `network:
  version: 2
  renderer: networkd
  ethernets:
    ${networkInterface}:
      dhcp4: false
      addresses:
        - ${ip}
      gateway4: ${gateway}
      nameservers:
        addresses:
${dns.map(d => `          - ${d}`).join("\n")}
`;

    while (attempt <= maxRetries && !success) {
      attempt++;
      
      if (attempt > 1) {
        logger.info("Retrying static IP configuration", { vmName, hostname, attempt, maxRetries });
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      const commands: Array<{ module: string; args: Record<string, any>; description: string }> = [];

      // Create netplan config file
      const netplanPath = `/etc/netplan/01-static-ip.yaml`;
      commands.push({
        module: "copy",
        args: {
          content: netplanYaml,
          dest: netplanPath,
          mode: "0644",
        },
        description: "Create netplan configuration file",
      });

      // Apply netplan configuration
      commands.push({
        module: "command",
        args: { _raw_params: "netplan apply" },
        description: "Apply netplan configuration",
      });

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
            throw new Error(`Failed to execute: ${cmd.description}`);
          }
        } catch (error: any) {
          errors.push(`[${cmd.description}] ${error.message}`);
          throw error;
        }
      }

      success = true;
      const duration = Date.now() - startTime;

      logger.info("Static IP configuration completed successfully", {
        vmName: resolvedVmName,
        hostname,
        ip,
        gateway,
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
        message: `Static IP ${ip} configured successfully on ${hostname}. Gateway: ${gateway}. ` +
          `Note: VM may lose connectivity temporarily during configuration.`,
      };
    }

    // Failed after all retries
    const duration = Date.now() - startTime;
    logger.error("Static IP configuration failed", {
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
      message: `Static IP configuration failed on ${hostname} after ${attempt} attempt(s).`,
      errors: [lastResult?.stderr || "Unknown error"],
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    logger.error("Set Static IP action error", {
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
      message: `Static IP configuration failed: ${error.message}`,
      errors: [error.message],
    };
  }
}


