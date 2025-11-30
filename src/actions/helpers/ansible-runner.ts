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
    this.ansibleDir = ansibleDir || join(process.cwd(), "lab-infra", "ansible");
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
    const playbookPath = join(this.ansibleDir, "playbooks", playbook);
    const inventoryPath = join(this.ansibleDir, inventory);

    const args: string[] = [
      `-i ${inventoryPath}`,
      playbookPath,
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
    inventory: string = "inventory.ini"
  ): Promise<AnsibleAdHocResult> {
    const inventoryPath = join(this.ansibleDir, inventory);

    const moduleArgs = Object.entries(args)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");

    const command = `ansible ${host} -i ${inventoryPath} -m ${module} -a "${moduleArgs}"`;

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

