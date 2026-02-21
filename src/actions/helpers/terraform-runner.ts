import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { pceLogger as logger } from "../../pce/utils/logger";

const execAsync = promisify(exec);

export interface TerraformConfig {
  vmConfigs: Record<
    string,
    {
      target_node: string;
      cores: number;
      memory: number;
      disk_size: string;
      vm_id?: number; // Optional: Specific VM ID to use (if not provided, Terraform auto-assigns)
    }
  >;
  sshPublicKey?: string; // Optional - will be read from env or ~/.ssh/id_ed25519.pub if not provided
  vmBridge?: string;
  vlanId?: number; // Optional: VLAN ID for network tagging (1-4094)
  datastore?: string;
  cloudInitDatastore?: string; // Datastore for cloud-init snippets (defaults to "local" in Terraform)
  templateId?: number; // Optional: VM template ID to clone from (defaults to 8001)
}

export interface TerraformResult {
  success: boolean;
  stdout: string;
  stderr: string;
  outputs?: Record<string, any>;
}

export interface TerraformOutput {
  vm_info?: Record<
    string,
      {
        name: string;
        node: string;
        id: number | string;
        hostname: string;
        ip_addresses: string[];
      }
  >;
  vm_hostnames?: Record<string, string>;
}

export type VmConfigEntry = {
  target_node: string;
  cores: number;
  memory: number;
  disk_size: string;
  vm_id?: number;
};

function extractHclObjectBlock(content: string, key: string): string | null {
  const assignmentRegex = new RegExp(`\\b${key}\\b\\s*=\\s*\\{`, "m");
  const assignmentMatch = assignmentRegex.exec(content);
  if (!assignmentMatch) return null;

  const openBraceIndex = content.indexOf("{", assignmentMatch.index);
  if (openBraceIndex < 0) return null;

  let depth = 0;
  for (let i = openBraceIndex; i < content.length; i++) {
    const ch = content[i];
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return content.slice(openBraceIndex + 1, i);
      }
    }
  }

  return null;
}

function extractHclAssignmentString(content: string, key: string): string | undefined {
  const regex = new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\n]*)"\\s*$`, "m");
  const match = content.match(regex);
  return match?.[1];
}

function extractHclAssignmentNumber(content: string, key: string): number | undefined {
  const regex = new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*$`, "m");
  const match = content.match(regex);
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
}

function extractHclAssignmentBoolean(content: string, key: string): boolean | undefined {
  const regex = new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*$`, "mi");
  const match = content.match(regex);
  if (!match?.[1]) return undefined;
  return match[1].toLowerCase() === "true";
}

function parseVmConfigBlock(block: string): VmConfigEntry | null {
  const targetNode = block.match(/\btarget_node\s*=\s*"([^"\n]+)"/)?.[1];
  const coresRaw = block.match(/\bcores\s*=\s*(\d+)/)?.[1];
  const memoryRaw = block.match(/\bmemory\s*=\s*(\d+)/)?.[1];
  const diskSize = block.match(/\bdisk_size\s*=\s*"([^"\n]+)"/)?.[1];
  const vmIdRaw = block.match(/\bvm_id\s*=\s*(\d+)/)?.[1];

  if (!targetNode || !coresRaw || !memoryRaw || !diskSize) {
    return null;
  }

  const cores = Number.parseInt(coresRaw, 10);
  const memory = Number.parseInt(memoryRaw, 10);
  if (!Number.isFinite(cores) || !Number.isFinite(memory)) {
    return null;
  }

  const vmId = vmIdRaw ? Number.parseInt(vmIdRaw, 10) : undefined;
  return {
    target_node: targetNode,
    cores,
    memory,
    disk_size: diskSize,
    vm_id: Number.isFinite(vmId) ? vmId : undefined,
  };
}

export function parseVmConfigsFromTfvars(content: string): Record<string, VmConfigEntry> {
  const vmConfigsBlock = extractHclObjectBlock(content, "vm_configs");
  if (!vmConfigsBlock) return {};

  const vmConfigs: Record<string, VmConfigEntry> = {};
  const entryRegex = /"([^"]+)"\s*=\s*\{/g;
  let entryMatch: RegExpExecArray | null;

  while ((entryMatch = entryRegex.exec(vmConfigsBlock)) !== null) {
    const vmName = entryMatch[1];
    const openBraceIndex = vmConfigsBlock.indexOf("{", entryMatch.index);
    if (!vmName || openBraceIndex < 0) continue;

    let depth = 0;
    let closeBraceIndex = -1;
    for (let i = openBraceIndex; i < vmConfigsBlock.length; i++) {
      const ch = vmConfigsBlock[i];
      if (ch === "{") {
        depth++;
        continue;
      }
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          closeBraceIndex = i;
          break;
        }
      }
    }

    if (closeBraceIndex < 0) continue;
    const entryBlock = vmConfigsBlock.slice(openBraceIndex + 1, closeBraceIndex);
    const parsed = parseVmConfigBlock(entryBlock);
    if (parsed) vmConfigs[vmName] = parsed;
  }

  return vmConfigs;
}

export function mergeVmConfigsWithExistingTfvars(
  existingTfvarsContent: string,
  incomingVmConfigs: Record<string, VmConfigEntry>
): Record<string, VmConfigEntry> {
  return {
    ...parseVmConfigsFromTfvars(existingTfvarsContent),
    ...incomingVmConfigs,
  };
}

/**
 * TerraformRunner - Executes terraform commands in the lab-infra directory
 */
export class TerraformRunner {
  private terraformDir: string;
  private environment: string;
  private targetNode?: string; // Track target node for cluster-aware token selection

  constructor(terraformDir?: string, environment: string = "palindrome") {
    this.terraformDir = terraformDir || join(process.cwd(), "lab-infra", "terraform");
    this.environment = environment;
  }

  /**
   * Set target node for cluster-aware token selection
   * This allows TerraformRunner to select the correct API endpoint and token
   * based on which node the VM will be created on.
   */
  setTargetNode(node: string): void {
    this.targetNode = node;
  }

  /**
   * Get SSH public key from config, env, or file
   */
  private async getSshPublicKey(config?: { sshPublicKey?: string }): Promise<string> {
    // Try config first
    if (config?.sshPublicKey) {
      return config.sshPublicKey.trim();
    }

    // Try environment variable
    if (process.env.SSH_PUBLIC_KEY) {
      return process.env.SSH_PUBLIC_KEY.trim();
    }

    // Try to read from default location
    const homeDir = process.env.HOME || (process.env.USER ? `/home/${process.env.USER}` : "/home/user");
    const defaultKeyPath = join(homeDir, ".ssh", "id_ed25519.pub");
    try {
      const keyContent = await readFile(defaultKeyPath, "utf-8");
      return keyContent.trim();
    } catch {
      throw new Error(
        `SSH public key not found. Set SSH_PUBLIC_KEY env var or ensure ${defaultKeyPath} exists`
      );
    }
  }

  /**
   * Get the path to the tfvars file
   */
  getTfvarsPath(): string {
    return join(
      process.cwd(),
      "lab-infra",
      "environments",
      `${this.environment}.tfvars`
    );
  }

  /**
   * Generate terraform variables file from config
   */
  private async generateTfVars(config: TerraformConfig): Promise<string> {
    const tfvarsPath = this.getTfvarsPath();
    let existingContent = "";
    try {
      existingContent = await readFile(tfvarsPath, "utf-8");
    } catch {
      existingContent = "";
    }

    // Get SSH public key
    const sshPublicKey = await this.getSshPublicKey(config);

    const mergedVmConfigs = mergeVmConfigsWithExistingTfvars(existingContent, config.vmConfigs);
    const vmBridgeValue = config.vmBridge || extractHclAssignmentString(existingContent, "vm_bridge") || "vmbr0";
    const vlanIdValue = config.vlanId ?? extractHclAssignmentNumber(existingContent, "vm_vlan_id");
    const useSshAgentValue = extractHclAssignmentBoolean(existingContent, "use_ssh_agent") ?? true;
    const cloudInitDatastoreValue =
      config.cloudInitDatastore ||
      extractHclAssignmentString(existingContent, "cloud_init_datastore") ||
      "local";
    const vmTemplateIdValue =
      config.templateId ||
      extractHclAssignmentNumber(existingContent, "vm_template_id") ||
      8001;

    // Build vm_configs block
    const vmConfigsBlock = Object.entries(mergedVmConfigs)
      .map(([name, cfg]) => {
        // Use 0 as sentinel for auto-assign (Terraform will convert to null)
        const vmIdValue = cfg.vm_id !== undefined && cfg.vm_id > 0 ? cfg.vm_id : 0;
        return `  "${name}" = {
    target_node = "${cfg.target_node}"
    cores       = ${cfg.cores}
    memory      = ${cfg.memory}
    disk_size   = "${cfg.disk_size}"
    vm_id       = ${vmIdValue}
  }`;
      })
      .join(",\n");

    // Generate new content
    const vlanIdLine = typeof vlanIdValue === "number" ? `vm_vlan_id = ${vlanIdValue}\n` : "";
    const newContent = `# Generated by Palindrome Action Layer
vm_bridge = "${vmBridgeValue}"
${vlanIdLine}use_ssh_agent = ${useSshAgentValue ? "true" : "false"}
ssh_public_key = "${sshPublicKey}"
cloud_init_datastore = "${cloudInitDatastoreValue}"
vm_template_id = ${vmTemplateIdValue}

vm_configs = {
${vmConfigsBlock}
}
`;

    await writeFile(tfvarsPath, newContent, "utf-8");
    logger.info("Updated terraform tfvars vm_configs", {
      incomingVmCount: Object.keys(config.vmConfigs).length,
      mergedVmCount: Object.keys(mergedVmConfigs).length,
      tfvarsPath,
    });
    return tfvarsPath;
  }

  async removeVmFromTfvars(vmName: string): Promise<boolean> {
    const tfvarsPath = this.getTfvarsPath();
    let existingContent = "";
    try {
      existingContent = await readFile(tfvarsPath, "utf-8");
    } catch {
      return false;
    }

    const existingVmConfigs = parseVmConfigsFromTfvars(existingContent);
    if (!existingVmConfigs[vmName]) {
      return false;
    }

    delete existingVmConfigs[vmName];

    const vmBridgeValue = extractHclAssignmentString(existingContent, "vm_bridge") || "vmbr0";
    const vlanIdValue = extractHclAssignmentNumber(existingContent, "vm_vlan_id");
    const useSshAgentValue = extractHclAssignmentBoolean(existingContent, "use_ssh_agent") ?? true;
    const sshPublicKey =
      extractHclAssignmentString(existingContent, "ssh_public_key") ||
      (await this.getSshPublicKey({}));
    const cloudInitDatastoreValue =
      extractHclAssignmentString(existingContent, "cloud_init_datastore") || "local";
    const vmTemplateIdValue =
      extractHclAssignmentNumber(existingContent, "vm_template_id") || 8001;

    const vmConfigsBlock = Object.entries(existingVmConfigs)
      .map(([name, cfg]) => {
        const vmIdValue = cfg.vm_id !== undefined && cfg.vm_id > 0 ? cfg.vm_id : 0;
        return `  "${name}" = {
    target_node = "${cfg.target_node}"
    cores       = ${cfg.cores}
    memory      = ${cfg.memory}
    disk_size   = "${cfg.disk_size}"
    vm_id       = ${vmIdValue}
  }`;
      })
      .join(",\n");
    const vlanIdLine = typeof vlanIdValue === "number" ? `vm_vlan_id = ${vlanIdValue}\n` : "";
    const updatedContent = `# Generated by Palindrome Action Layer
vm_bridge = "${vmBridgeValue}"
${vlanIdLine}use_ssh_agent = ${useSshAgentValue ? "true" : "false"}
ssh_public_key = "${sshPublicKey}"
cloud_init_datastore = "${cloudInitDatastoreValue}"
vm_template_id = ${vmTemplateIdValue}

vm_configs = {
${vmConfigsBlock}
}
`;

    await writeFile(tfvarsPath, updatedContent, "utf-8");
    logger.info("Removed VM from terraform tfvars vm_configs", {
      vmName,
      remainingVmCount: Object.keys(existingVmConfigs).length,
      tfvarsPath,
    });
    return true;
  }

  async removeVmFromState(vmName: string): Promise<{ removed: string[]; missing: string[] }> {
    const targets = [
      `proxmox_virtual_environment_vm.lab_vms["${vmName}"]`,
      `proxmox_virtual_environment_file.cloud_config["${vmName}"]`,
    ];
    const removed: string[] = [];
    const missing: string[] = [];

    for (const target of targets) {
      try {
        const result = await execAsync(`terraform state rm '${target}'`, {
          cwd: this.terraformDir,
          env: process.env as Record<string, string>,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 120000,
        });
        const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
        if (/No matching objects found/i.test(output)) {
          missing.push(target);
        } else {
          removed.push(target);
        }
      } catch (error: any) {
        const output = `${error?.stdout || ""}\n${error?.stderr || ""}\n${error?.message || ""}`;
        if (/No matching objects found/i.test(output)) {
          missing.push(target);
          continue;
        }
        throw error;
      }
    }

    logger.info("Terraform state cleanup for destroyed VM completed", {
      vmName,
      removed,
      missing,
    });
    return { removed, missing };
  }

  /**
   * Get terraform environment variables
   * Supports cluster nodes by selecting the appropriate URL and token based on target node
   */
  private getTerraformEnv(): Record<string, string> {
    const targetNode = this.targetNode;
    const env: Record<string, string> = {};
    
    // CRITICAL: Copy ALL environment variables, especially SSH agent vars
    // The bpg/proxmox provider requires SSH_AUTH_SOCK and SSH_AGENT_PID for ssh-agent auth
    // Without these, it falls back to password auth which fails
    for (const key in process.env) {
      const value = process.env[key];
      if (value !== undefined) {
        env[key] = value;
      }
    }
    
    // Explicitly ensure SSH agent vars are preserved (defensive)
    if (process.env.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
    }
    if (process.env.SSH_AGENT_PID) {
      env.SSH_AGENT_PID = process.env.SSH_AGENT_PID;
    }

    // Determine which node we're targeting and select appropriate URL/token
    let proxmoxUrl: string | undefined;
    let tokenId: string | undefined;
    let tokenSecret: string | undefined;

    // Normalize node name for matching
    const nodeLower = targetNode?.toLowerCase() || "";

    // Check for node-specific URLs and tokens
    if (nodeLower === "yin" || nodeLower === "yang") {
      // Cluster nodes - use cluster-specific config
      proxmoxUrl = nodeLower === "yin" 
        ? process.env.PROXMOX_YIN_URL || process.env.PROXMOX_URL
        : process.env.PROXMOX_YANG_URL || process.env.PROXMOX_URL;
      
      tokenId = process.env.CLUSTER_TF_TOKEN_ID;
      // Try node-specific secret first, fallback to cluster secret
      if (nodeLower === "yin") {
        tokenSecret = process.env.PROXMOX_YIN_TF_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
      } else {
        tokenSecret = process.env.PROXMOX_YANG_TF_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
      }
    } else {
      // proxBig or default - use proxBig config
      proxmoxUrl = process.env.PROXMOX_URL;
      tokenId = process.env.CLUSTER_TF_TOKEN_ID || process.env.PROXBIG_TF_TOKEN_ID;
      // Try proxBig-specific secret (check multiple possible variable names), then fallback to cluster secret
      tokenSecret = process.env.PROXMOX_PROXBIG_TF_SECRET || process.env.PROXBIG_TF_SECRET || process.env.PROXBIG_TOKEN_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
    }

    // Validate required variables
    if (!proxmoxUrl) {
      throw new Error(
        `PROXMOX_URL environment variable is required for node "${targetNode || "default"}"`
      );
    }

    if (!tokenId || !tokenSecret) {
      const missing = [];
      if (!tokenId) missing.push(`Token ID for ${targetNode || "default"}`);
      if (!tokenSecret) missing.push(`Token secret for ${targetNode || "default"}`);
      
      throw new Error(
        `Missing required terraform token for node "${targetNode || "default"}": ${missing.join(", ")}\n` +
        `For cluster nodes (yin/yang), set:\n` +
        `  - PROXMOX_YIN_TF_SECRET or PROXMOX_YANG_TF_SECRET (node-specific), or\n` +
        `  - PROXMOX_CLUSTER_TF_SECRET (shared cluster token)\n` +
        `For proxBig, set:\n` +
        `  - PROXMOX_CLUSTER_TF_SECRET or PROXMOX_PROXBIG_TF_SECRET`
      );
    }

    // Terraform provider expects full API URL with /api2/json path
    // Keep the full URL as-is (provider will handle it)
    let cleanUrl = proxmoxUrl;
    if (!cleanUrl.includes("/api2/json")) {
      // If missing, add it
      cleanUrl = cleanUrl.replace(/\/$/, "") + "/api2/json";
    }
    // Strip /api2/json for Terraform provider (it adds it automatically)
    // The provider expects just the base URL
    const terraformUrl = cleanUrl.replace(/\/api2\/json\/?$/, "");
    env.TF_VAR_proxmox_api_url = terraformUrl;

    // Terraform expects format: user@realm!tokenid=secret
    // The tokenId should already be in format "user@realm!tokenid", so we just append =secret
    const fullToken = `${tokenId}=${tokenSecret}`;
    env.TF_VAR_proxmox_token_secret = fullToken;
    
    // Debug logging (redact secret for security)
    logger.info("Terraform token configuration", {
      targetNode,
      tokenId,
      tokenSecretLength: tokenSecret?.length || 0,
      tokenSecretPrefix: tokenSecret?.substring(0, 8) || "missing",
      proxmoxUrl: terraformUrl,
      fullUrl: cleanUrl,
    });

    // Get SSH public key - terraform will read from file if not set
    const sshPublicKey = process.env.SSH_PUBLIC_KEY;
    if (sshPublicKey) {
      env.TF_VAR_ssh_public_key = sshPublicKey;
    } else {
      // Terraform will try to read from ~/.ssh/id_ed25519.pub by default
      // This is handled in the terraform variables.tf file
      logger.debug("SSH_PUBLIC_KEY not set, terraform will use default location or fail with clear error");
    }

    return env;
  }

  /**
   * Execute terraform command
   * Public for targeted operations like destroy -target
   */
  async executeTerraform(
    command: string,
    args: string[] = []
  ): Promise<TerraformResult> {
    const fullCommand = `terraform ${command} ${args.join(" ")}`;
    const env = this.getTerraformEnv();

    logger.info("Executing terraform", { command: fullCommand, cwd: this.terraformDir });

    try {
      const { stdout, stderr } = await execAsync(fullCommand, {
        cwd: this.terraformDir,
        env,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        timeout: 300000, // 5 minute timeout
      });

      // Check for errors in stderr even if command succeeded (terraform sometimes returns 0 on errors)
      if (stderr && (stderr.includes("Error:") || stderr.includes("error"))) {
        logger.warn("Terraform command completed but stderr contains errors", { stderr });
        return {
          success: false,
          stdout,
          stderr,
        };
      }

      return {
        success: true,
        stdout,
        stderr,
      };
    } catch (error: any) {
      logger.error("Terraform execution failed", {
        command: fullCommand,
        error: error.message,
        stdout: error.stdout,
        stderr: error.stderr,
      });

      // Extract stderr from error if available
      const errorStderr = error.stderr || error.message || "";
      const errorStdout = error.stdout || "";

      return {
        success: false,
        stdout: errorStdout,
        stderr: errorStderr,
      };
    }
  }

  /**
   * Run terraform init
   */
  async init(): Promise<TerraformResult> {
    return this.executeTerraform("init");
  }

  /**
   * Run terraform plan
   * For dry-run operations, we use -lock=false since plan is read-only
   */
  async plan(config: TerraformConfig, skipLock: boolean = true): Promise<TerraformResult> {
    await this.generateTfVars(config);
    const tfvarsPath = join(
      process.cwd(),
      "lab-infra",
      "environments",
      `${this.environment}.tfvars`
    );

    const args = [
      `-var-file="${tfvarsPath}"`,
      "-out=tfplan",
      "-input=false", // Non-interactive mode
    ];

    // For dry-run (plan), skip lock since it's read-only
    if (skipLock) {
      args.push("-lock=false");
    }

    return this.executeTerraform("plan", args);
  }

  /**
   * Run terraform apply
   */
  async apply(config: TerraformConfig): Promise<TerraformResult> {
    await this.generateTfVars(config);
    const tfvarsPath = join(
      process.cwd(),
      "lab-infra",
      "environments",
      `${this.environment}.tfvars`
    );

    const result = await this.executeTerraform("apply", [
      `-var-file="${tfvarsPath}"`,
      "-auto-approve",
      "-input=false", // Non-interactive mode
    ]);

    // Refresh state and get outputs
    if (result.success) {
      await this.refresh(config);
      const outputs = await this.getOutputs();
      result.outputs = outputs;
    }

    return result;
  }

  /**
   * Run terraform destroy
   */
  async destroy(config: TerraformConfig): Promise<TerraformResult> {
    await this.generateTfVars(config);
    const tfvarsPath = join(
      process.cwd(),
      "lab-infra",
      "environments",
      `${this.environment}.tfvars`
    );

    return this.executeTerraform("destroy", [
      `-var-file="${tfvarsPath}"`,
      "-auto-approve",
    ]);
  }

  /**
   * Run terraform refresh
   * Note: refresh needs var-file to avoid prompting for variables
   */
  async refresh(config?: TerraformConfig): Promise<TerraformResult> {
    if (config) {
      await this.generateTfVars(config);
    }
    const tfvarsPath = join(
      process.cwd(),
      "lab-infra",
      "environments",
      `${this.environment}.tfvars`
    );
    return this.executeTerraform("refresh", [
      `-var-file="${tfvarsPath}"`,
      "-input=false",
    ]);
  }

  /**
   * Get terraform outputs
   */
  async getOutputs(): Promise<TerraformOutput> {
    const result = await this.executeTerraform("output", ["-json"]);

    if (!result.success) {
      logger.warn("Failed to get terraform outputs", { stderr: result.stderr });
      return {};
    }

    try {
      const rawOutputs = JSON.parse(result.stdout);
      // Terraform outputs are nested: { "output_name": { "value": actual_value } }
      // Extract the "value" from each output
      const outputs: TerraformOutput = {};
      if (rawOutputs.vm_info?.value) {
        outputs.vm_info = rawOutputs.vm_info.value;
      }
      if (rawOutputs.vm_hostnames?.value) {
        outputs.vm_hostnames = rawOutputs.vm_hostnames.value;
      }
      return outputs;
    } catch (error: any) {
      logger.error("Failed to parse terraform outputs", { error: error.message, stdout: result.stdout });
      return {};
    }
  }

  /**
   * Get terraform state
   */
  async getState(): Promise<any> {
    const result = await this.executeTerraform("show", ["-json"]);

    if (!result.success) {
      logger.warn("Failed to get terraform state", { stderr: result.stderr });
      return null;
    }

    try {
      return JSON.parse(result.stdout);
    } catch (error: any) {
      logger.error("Failed to parse terraform state", { error: error.message });
      return null;
    }
  }

  /**
   * Force unlock terraform state (use with caution)
   * Only use if you're sure no other terraform process is running
   */
  async forceUnlock(lockId?: string): Promise<TerraformResult> {
    const args = lockId ? [lockId, "-force"] : ["-force"];
    logger.warn("Force unlocking terraform state", { lockId });
    return this.executeTerraform("force-unlock", args);
  }
}
