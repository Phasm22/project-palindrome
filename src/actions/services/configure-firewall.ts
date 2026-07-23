import { z } from "zod";
import { isIP } from "net";
import { pceLogger as logger } from "../../pce/utils/logger";
import { AnsibleRunner } from "../helpers/ansible-runner";
import {
  resolveVmToHostname,
  ensureHostnameInInventory,
  waitForSshAccessible,
  verifyVmIsRunning,
} from "../helpers/ansible-helpers";

/**
 * Configure Firewall Action Schema
 */
export const ConfigureFirewallSchema = z.object({
  vmName: z.string().min(1, "VM name is required").describe("VM name to configure UFW firewall on (resolved via digital twin to obtain the SSH hostname)"),
  rules: z.array(z.object({
    port: z.number().int().positive().describe("Port number to allow or deny"),
    protocol: z.enum(["tcp", "udp", "both"]).default("tcp").describe("Protocol: 'tcp', 'udp', or 'both' (default: 'tcp')"),
    action: z.enum(["allow", "deny"]).default("allow").describe("Firewall action: 'allow' or 'deny' (default: 'allow')"),
    source: z.string().default("any").refine(isValidFirewallSource, {
      message: "Source must be 'any', an IP address, or a valid CIDR",
    }).describe("Traffic source: 'any', an IP address, or CIDR (default: 'any')"),
  })).optional().describe("UFW rules to apply (optional; each rule specifies port, protocol, and action)"),
  defaultPolicy: z.enum(["allow", "deny"]).default("deny").describe("Default UFW policy for unmatched traffic (default: 'deny')"),
  waitForVm: z.boolean().default(true).describe("Wait for SSH to become accessible before running ansible commands (default: true)"),
  timeout: z.number().int().positive().default(300).describe("SSH wait timeout in seconds (default: 300)"),
  retryOnFailure: z.boolean().default(false).describe("Retry on failure (default: false)"),
  maxRetries: z.number().int().positive().default(1).describe("Maximum number of retry attempts when retryOnFailure is true (default: 1)"),
  dryRun: z.boolean().default(false).describe("Preview without executing firewall changes (default: false)"),
});

export type ConfigureFirewallParams = z.infer<typeof ConfigureFirewallSchema>;

export interface ConfigureFirewallResult {
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

export function isValidFirewallSource(source: string): boolean {
  if (source === "any") return true;
  const [address, prefix, ...extra] = source.split("/");
  if (!address || extra.length > 0) return false;
  const family = isIP(address);
  if (family === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  const numericPrefix = Number.parseInt(prefix, 10);
  return family === 4
    ? numericPrefix >= 0 && numericPrefix <= 32
    : numericPrefix >= 0 && numericPrefix <= 128;
}

export function buildUfwRuleCommand(rule: {
  port: number;
  protocol: "tcp" | "udp" | "both";
  action: "allow" | "deny";
  source?: string;
}): string {
  const protocol = rule.protocol === "both" ? "" : ` proto ${rule.protocol}`;
  const source = rule.source ?? "any";
  if (source === "any") {
    const portProtocol = rule.protocol === "both" ? "" : `/${rule.protocol}`;
    return `ufw ${rule.action} ${rule.port}${portProtocol}`;
  }
  return `ufw ${rule.action} from ${source} to any port ${rule.port}${protocol}`;
}

/**
 * Configure Firewall Action
 * 
 * Configures UFW (Uncomplicated Firewall) rules on a VM using Ansible.
 */
export async function configureFirewall(params: ConfigureFirewallParams): Promise<ConfigureFirewallResult> {
  const startTime = Date.now();
  const {
    vmName,
    rules = [],
    defaultPolicy,
    waitForVm,
    timeout,
    retryOnFailure,
    maxRetries,
    dryRun,
  } = params;

  logger.info("Configure Firewall action started", { vmName, rulesCount: rules.length, defaultPolicy, dryRun });

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
        message: `VM "${resolvedVmName}" is not running. Please start the VM before configuring firewall.`,
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

    // 5. Configure UFW using ad-hoc Ansible commands
    const ansibleRunner = new AnsibleRunner(ansibleDir);
    let lastResult: any = null;
    let attempt = 0;
    let success = false;

    if (dryRun) {
      logger.info("Dry-run: Would configure firewall", { hostname, rules, defaultPolicy });
      return {
        success: true,
        vmName: resolvedVmName,
        hostname,
        changed: false,
        failed: false,
        stdout: "",
        stderr: "",
        duration: Date.now() - startTime,
        message: `Dry-run: Would configure firewall on ${hostname} with ${rules.length} rule(s) and default policy ${defaultPolicy}`,
      };
    }

    while (attempt <= maxRetries && !success) {
      attempt++;
      
      if (attempt > 1) {
        logger.info("Retrying firewall configuration", { vmName, hostname, attempt, maxRetries });
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      const commands: Array<{ module: string; args: Record<string, any>; description: string }> = [];

      // Install UFW if not present
      commands.push({
        module: "apt",
        args: { name: "ufw", state: "present", update_cache: "yes" },
        description: "Install UFW package",
      });

      // Set default policy
      commands.push({
        module: "command",
        args: { _raw_params: `ufw default ${defaultPolicy}` },
        description: `Set default policy to ${defaultPolicy}`,
      });

      // Add rules
      for (const rule of rules) {
        const protocol = rule.protocol === "both" ? "" : `/${rule.protocol}`;
        const action = rule.action === "allow" ? "allow" : "deny";
        commands.push({
          module: "command",
          args: { _raw_params: buildUfwRuleCommand(rule) },
          description: `${action} ${rule.port}${protocol} from ${rule.source}`,
        });
      }

      // Enable UFW (non-interactive)
      commands.push({
        module: "command",
        args: { _raw_params: "ufw --force enable" },
        description: "Enable UFW firewall",
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
            // Some UFW commands may return non-zero but still succeed (e.g., rule already exists)
            if (cmd.description.includes("ufw") && result.stdout.includes("already")) {
              logger.info("UFW rule already exists, continuing", { cmd: cmd.description });
              continue;
            }
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
          // UFW may return errors for duplicate rules, but that's okay
          if (cmd.description.includes("ufw") && (error.message.includes("already") || error.message.includes("duplicate"))) {
            logger.info("UFW rule already exists, continuing", { cmd: cmd.description });
            continue;
          }
          errors.push(`[${cmd.description}] ${error.message}`);
          throw error;
        }
      }

      success = true;
      const duration = Date.now() - startTime;

      logger.info("Firewall configuration completed successfully", {
        vmName: resolvedVmName,
        hostname,
        changed,
        rulesCount: rules.length,
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
        message: `Firewall configured successfully on ${hostname}. ` +
          `Default policy: ${defaultPolicy}, ${rules.length} rule(s) applied.`,
      };
    }

    // Failed after all retries
    const duration = Date.now() - startTime;
    logger.error("Firewall configuration failed", {
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
      message: `Firewall configuration failed on ${hostname} after ${attempt} attempt(s).`,
      errors: [lastResult?.stderr || "Unknown error"],
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    logger.error("Configure Firewall action error", {
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
      message: `Firewall configuration failed: ${error.message}`,
      errors: [error.message],
    };
  }
}
