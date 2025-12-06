import { exec } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { pceLogger as logger } from "../../pce/utils/logger";

const execAsync = promisify(exec);

export interface AnsiblePlaybookResult {
  success: boolean;
  stdout: string;
  stderr: string;
  changed: boolean;
  failed: boolean;
}

export interface AnsibleAdHocResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

/**
 * AnsibleRunner - Executes ansible playbooks and ad-hoc commands
 */
export class AnsibleRunner {
  private ansibleDir: string;

  constructor(ansibleDir?: string) {
    // Normalize to absolute path
    if (ansibleDir) {
      this.ansibleDir = ansibleDir.startsWith("/") 
        ? ansibleDir 
        : join(process.cwd(), ansibleDir);
    } else {
      this.ansibleDir = join(process.cwd(), "lab-infra", "ansible");
    }
  }

  /**
   * Run ansible playbook
   */
  async runPlaybook(
    playbook: string,
    inventory: string = "inventory.ini",
    extraVars?: Record<string, any>,
    limit?: string
  ): Promise<AnsiblePlaybookResult> {
    // Handle both absolute paths and relative paths
    let playbookPath: string;
    if (playbook.startsWith("/") || playbook.includes("..")) {
      // Absolute path or path with .. - use as-is
      playbookPath = playbook;
    } else {
      // Relative path - join with playbooks directory
      playbookPath = join(this.ansibleDir, "playbooks", playbook);
    }
    const inventoryPath = join(this.ansibleDir, inventory);

    // Use relative paths since we're running from ansibleDir
    // playbookPath is absolute, but we need relative to ansibleDir
    const playbookRelative = playbookPath.startsWith(this.ansibleDir)
      ? playbookPath.substring(this.ansibleDir.length + 1) // Remove ansibleDir prefix and leading slash
      : playbookPath;
    
    // inventoryPath should also be relative
    const inventoryRelative = inventoryPath.startsWith(this.ansibleDir)
      ? inventoryPath.substring(this.ansibleDir.length + 1)
      : inventory;

    const args: string[] = [
      `-i ${inventoryRelative}`,
      playbookRelative,
    ];

    if (extraVars) {
      const extraVarsStr = Object.entries(extraVars)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      args.push(`--extra-vars "${extraVarsStr}"`);
    }

    if (limit) {
      args.push(`--limit ${limit}`);
    }

    const command = `ansible-playbook ${args.join(" ")}`;

    logger.info("Executing ansible playbook", { command, cwd: this.ansibleDir });

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.ansibleDir,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      // Parse output to determine if changes were made
      const changed = stdout.includes("changed=") && stdout.match(/changed=(\d+)/)?.[1] !== "0";
      const failed = stdout.includes("failed=") && stdout.match(/failed=(\d+)/)?.[1] !== "0";

      return {
        success: true,
        stdout,
        stderr,
        changed: changed || false,
        failed: failed || false,
      };
    } catch (error: any) {
      logger.error("Ansible playbook execution failed", {
        command,
        error: error.message,
        stdout: error.stdout,
        stderr: error.stderr,
      });

      return {
        success: false,
        stdout: error.stdout || "",
        stderr: error.stderr || error.message || "",
        changed: false,
        failed: true,
      };
    }
  }

  /**
   * Run ansible ad-hoc command
   */
  async runAdHoc(
    host: string,
    module: string,
    args: Record<string, any>,
    inventory: string = "inventory.ini",
    become: boolean = true
  ): Promise<AnsibleAdHocResult> {
    // Use relative path since we're running from ansibleDir
    const inventoryRelative = inventory.startsWith("/") || inventory.includes("..")
      ? inventory // Absolute path or path with .. - use as-is
      : inventory; // Relative path - use as-is (relative to ansibleDir)

    // Special handling for command module: pass command directly without parameter name
    let moduleArgs: string;
    if (module === "command" && args._raw_params) {
      // For command module, just pass the command directly
      moduleArgs = args._raw_params;
    } else {
      // For other modules, format as key=value pairs
      moduleArgs = Object.entries(args)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
    }

    const parts = [
      "ansible",
      host,
      `-i ${inventoryRelative}`,
      become ? "-b" : "",
      `-m ${module}`,
      `-a "${moduleArgs}"`,
    ].filter(Boolean); // Remove empty strings
    
    const command = parts.join(" ");

    logger.info("Executing ansible ad-hoc command", { command, cwd: this.ansibleDir });

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.ansibleDir,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      return {
        success: true,
        stdout,
        stderr,
      };
    } catch (error: any) {
      logger.error("Ansible ad-hoc command failed", {
        command,
        error: error.message,
        stdout: error.stdout,
        stderr: error.stderr,
      });

      return {
        success: false,
        stdout: error.stdout || "",
        stderr: error.stderr || error.message || "",
      };
    }
  }

  /**
   * Test connectivity to hosts
   */
  async ping(inventory: string = "inventory.ini", limit?: string): Promise<boolean> {
    const inventoryPath = join(this.ansibleDir, inventory);
    const args = limit ? [`-i ${inventoryPath}`, `--limit ${limit}`, "-m ping"] : [`-i ${inventoryPath}`, "-m ping", "all"];

    const command = `ansible ${args.join(" ")}`;

    try {
      const { stdout } = await execAsync(command, {
        cwd: this.ansibleDir,
        maxBuffer: 10 * 1024 * 1024,
      });

      // Check if all hosts responded
      const successCount = (stdout.match(/SUCCESS/g) || []).length;
      return successCount > 0;
    } catch {
      return false;
    }
  }
}

