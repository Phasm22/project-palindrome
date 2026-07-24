import { exec } from "child_process";
import { promisify } from "util";
import { readFile, readdir, writeFile } from "fs/promises";
import { basename, join } from "path";
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
      template_id?: number;
      ssh_username?: string;
      ssh_public_key?: string;
      datastore?: string;
      cloud_init_datastore?: string;
      vm_bridge?: string;
      vlan_id?: number;
      bios?: "seabios" | "ovmf";
      disk_interface?: "virtio0" | "scsi0" | "sata0";
    }
  >;
  sshPublicKey?: string; // Optional - will be read from env or ~/.ssh/id_ed25519.pub if not provided
  sshUsername?: string;
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
  template_id?: number;
  ssh_username?: string;
  ssh_public_key?: string;
  datastore?: string;
  cloud_init_datastore?: string;
  vm_bridge?: string;
  vlan_id?: number;
  bios?: "seabios" | "ovmf";
  disk_interface?: "virtio0" | "scsi0" | "sata0";
};

export interface TerraformVmConfigSource {
  environment: string;
  sourcePath: string;
  vmConfigs: Record<string, VmConfigEntry>;
}

export interface TerraformExecutionOptions {
  skipLock?: boolean;
  targets?: string[];
  tfvarsPath?: string;
  baseTfvarsPath?: string;
  statePath?: string;
  planPath?: string;
}

export interface TerraformProxmoxAuthConfig {
  proxmoxUrl?: string;
  tokenId?: string;
  tokenSecret?: string;
}

const DEFAULT_CLUSTER_NODE_URLS: Record<string, string> = {
  yin: "https://yin.prox:8006",
  yang: "https://yang.prox:8006",
};

export function resolveTerraformProxmoxAuth(
  targetNode?: string,
  env: NodeJS.ProcessEnv = process.env
): TerraformProxmoxAuthConfig {
  const nodeLower = targetNode?.toLowerCase() || "";

  if (nodeLower === "yin" || nodeLower === "yang") {
    const nodeSpecificUrl = nodeLower === "yin" ? env.PROXMOX_YIN_URL : env.PROXMOX_YANG_URL;
    const nodeSpecificTokenId = nodeLower === "yin" ? env.PROXMOX_YIN_TF_TOKEN_ID : env.PROXMOX_YANG_TF_TOKEN_ID;
    const nodeSpecificTokenSecret = nodeLower === "yin" ? env.PROXMOX_YIN_TF_SECRET : env.PROXMOX_YANG_TF_SECRET;

    return {
      proxmoxUrl: nodeSpecificUrl || DEFAULT_CLUSTER_NODE_URLS[nodeLower],
      tokenId: nodeSpecificTokenId || env.CLUSTER_TF_TOKEN_ID,
      tokenSecret: nodeSpecificTokenSecret || env.PROXMOX_CLUSTER_TF_SECRET,
    };
  }

  return {
    proxmoxUrl: env.PROXMOX_URL,
    tokenId: env.CLUSTER_TF_TOKEN_ID || env.PROXBIG_TF_TOKEN_ID,
    tokenSecret:
      env.PROXMOX_PROXBIG_TF_SECRET ||
      env.PROXBIG_TF_SECRET ||
      env.PROXBIG_TOKEN_SECRET ||
      env.PROXMOX_CLUSTER_TF_SECRET,
  };
}

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
  const templateIdRaw = block.match(/\btemplate_id\s*=\s*(\d+)/)?.[1];
  const sshUsername = block.match(/\bssh_username\s*=\s*"([^"\n]+)"/)?.[1];
  const sshPublicKey = block.match(/\bssh_public_key\s*=\s*"([^"\n]+)"/)?.[1];
  const datastore = block.match(/\bdatastore\s*=\s*"([^"\n]+)"/)?.[1];
  const cloudInitDatastore = block.match(/\bcloud_init_datastore\s*=\s*"([^"\n]+)"/)?.[1];
  const vmBridge = block.match(/\bvm_bridge\s*=\s*"([^"\n]+)"/)?.[1];
  const vlanIdRaw = block.match(/\bvlan_id\s*=\s*(\d+)/)?.[1];
  const bios = block.match(/\bbios\s*=\s*"(seabios|ovmf)"/)?.[1] as
    | VmConfigEntry["bios"]
    | undefined;
  const diskInterface = block.match(/\bdisk_interface\s*=\s*"(virtio0|scsi0|sata0)"/)?.[1] as
    | VmConfigEntry["disk_interface"]
    | undefined;

  if (!targetNode || !coresRaw || !memoryRaw || !diskSize) {
    return null;
  }

  const cores = Number.parseInt(coresRaw, 10);
  const memory = Number.parseInt(memoryRaw, 10);
  if (!Number.isFinite(cores) || !Number.isFinite(memory)) {
    return null;
  }

  const vmId = vmIdRaw ? Number.parseInt(vmIdRaw, 10) : undefined;
  const templateId = templateIdRaw ? Number.parseInt(templateIdRaw, 10) : undefined;
  const parsed: VmConfigEntry = {
    target_node: targetNode,
    cores,
    memory,
    disk_size: diskSize,
  };
  if (Number.isFinite(vmId)) parsed.vm_id = vmId;
  if (Number.isFinite(templateId)) parsed.template_id = templateId;
  if (sshUsername) parsed.ssh_username = sshUsername;
  if (sshPublicKey) parsed.ssh_public_key = sshPublicKey;
  if (datastore) parsed.datastore = datastore;
  if (cloudInitDatastore) parsed.cloud_init_datastore = cloudInitDatastore;
  if (vmBridge) parsed.vm_bridge = vmBridge;
  if (vlanIdRaw) parsed.vlan_id = Number.parseInt(vlanIdRaw, 10);
  if (bios) parsed.bios = bios;
  if (diskInterface) parsed.disk_interface = diskInterface;
  return parsed;
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

/**
 * Read the declared VM sets from environment tfvars without invoking Terraform.
 *
 * The returned list is sorted by path so ingestion is deterministic. Files
 * without a vm_configs block are included with an empty VM set, allowing
 * callers to report which declarations were inspected.
 */
export async function readTerraformVmConfigsFromEnvironmentDirectory(
  environmentsDir: string = join(process.cwd(), "lab-infra", "environments")
): Promise<TerraformVmConfigSource[]> {
  const entries = await readdir(environmentsDir, { withFileTypes: true });
  const tfvarsPaths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tfvars"))
    .map((entry) => join(environmentsDir, entry.name))
    .sort();

  return Promise.all(
    tfvarsPaths.map(async (sourcePath) => ({
      environment: basename(sourcePath, ".tfvars"),
      sourcePath,
      vmConfigs: parseVmConfigsFromTfvars(await readFile(sourcePath, "utf8")),
    }))
  );
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

export function parseManagedVmNamesFromTerraformStateList(stateListOutput: string): Set<string> {
  const names = new Set<string>();
  const pattern = /proxmox_virtual_environment_vm\.lab_vms\["([^"]+)"\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stateListOutput)) !== null) {
    const vmName = match[1];
    if (vmName) names.add(vmName);
  }
  return names;
}

export function parseCloudConfigNamesFromTerraformStateList(
  stateListOutput: string
): Set<string> {
  const names = new Set<string>();
  const pattern = /proxmox_virtual_environment_file\.cloud_config\["([^"]+)"\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stateListOutput)) !== null) {
    const vmName = match[1];
    if (vmName) names.add(vmName);
  }
  return names;
}

export function getTerraformStateRemovalTargets(
  vmName: string,
  stateListOutput: string
): string[] {
  const managedVmNames = parseManagedVmNamesFromTerraformStateList(stateListOutput);
  const cloudConfigNames = parseCloudConfigNamesFromTerraformStateList(stateListOutput);
  const orphanedCloudConfigNames = Array.from(cloudConfigNames)
    .filter((name) => !managedVmNames.has(name))
    .sort();
  const targets = new Set([
    `proxmox_virtual_environment_vm.lab_vms["${vmName}"]`,
    `proxmox_virtual_environment_file.cloud_config["${vmName}"]`,
    ...orphanedCloudConfigNames.map(
      (name) => `proxmox_virtual_environment_file.cloud_config["${name}"]`
    ),
  ]);
  return Array.from(targets);
}

export function renderAnsibleInventory(outputs: TerraformOutput): string {
  const hostnames = new Set<string>();
  for (const hostname of Object.values(outputs.vm_hostnames || {})) {
    if (hostname) hostnames.add(hostname);
  }
  for (const [name, vm] of Object.entries(outputs.vm_info || {})) {
    hostnames.add(vm.hostname || `${name}.prox`);
  }

  const hosts = Array.from(hostnames)
    .sort()
    .map((hostname) => `${hostname} ansible_host=${hostname} ansible_user=ops`);
  return [
    "# Generated from Terraform state by Palindrome",
    "[lab_vms]",
    ...hosts,
    "",
    "[lab_vms:vars]",
    "ansible_ssh_common_args='-o StrictHostKeyChecking=no'",
    "",
  ].join("\n");
}

export function reconcileVmConfigsWithTerraformState(
  existingTfvarsContent: string,
  managedVmNames: Iterable<string>,
  incomingVmConfigs: Record<string, VmConfigEntry> = {}
): {
  reconciledVmConfigs: Record<string, VmConfigEntry>;
  removedVmNames: string[];
} {
  const existingVmConfigs = parseVmConfigsFromTfvars(existingTfvarsContent);
  const keepNames = new Set<string>(managedVmNames);
  for (const name of Object.keys(incomingVmConfigs)) {
    keepNames.add(name);
  }

  const reconciledVmConfigs: Record<string, VmConfigEntry> = {};
  const removedVmNames: string[] = [];

  for (const [name, cfg] of Object.entries(existingVmConfigs)) {
    if (keepNames.has(name)) {
      reconciledVmConfigs[name] = cfg;
    } else {
      removedVmNames.push(name);
    }
  }

  return { reconciledVmConfigs, removedVmNames };
}

function formatVmConfigEntry(name: string, cfg: VmConfigEntry): string {
  const vmIdValue = cfg.vm_id !== undefined && cfg.vm_id > 0 ? cfg.vm_id : 0;
  const optionalLines = [
    cfg.template_id !== undefined && cfg.template_id > 0 ? `    template_id    = ${cfg.template_id}` : "",
    cfg.ssh_username ? `    ssh_username   = "${cfg.ssh_username}"` : "",
    cfg.ssh_public_key ? `    ssh_public_key = "${cfg.ssh_public_key}"` : "",
    cfg.datastore ? `    datastore              = "${cfg.datastore}"` : "",
    cfg.cloud_init_datastore
      ? `    cloud_init_datastore   = "${cfg.cloud_init_datastore}"`
      : "",
    cfg.vm_bridge ? `    vm_bridge              = "${cfg.vm_bridge}"` : "",
    cfg.vlan_id !== undefined ? `    vlan_id                = ${cfg.vlan_id}` : "",
    cfg.bios ? `    bios                   = "${cfg.bios}"` : "",
    cfg.disk_interface
      ? `    disk_interface         = "${cfg.disk_interface}"`
      : "",
  ].filter(Boolean);
  const optionalBlock = optionalLines.length > 0 ? `\n${optionalLines.join("\n")}` : "";

  return `  "${name}" = {
    target_node = "${cfg.target_node}"
    cores       = ${cfg.cores}
    memory      = ${cfg.memory}
    disk_size   = "${cfg.disk_size}"
    vm_id       = ${vmIdValue}${optionalBlock}
  }`;
}

function formatTerraformTargetArg(target: string): string {
  return `-target='${target.replace(/'/g, "'\\''")}'`;
}

function resolveUseSshAgentValue(existingContent: string): boolean {
  const explicit = extractHclAssignmentBoolean(existingContent, "use_ssh_agent");
  const hasAgentSocket = Boolean(process.env.SSH_AUTH_SOCK);
  if (explicit === false) return false;
  if (explicit === true) {
    if (hasAgentSocket) return true;
    logger.warn("use_ssh_agent=true in tfvars but SSH_AUTH_SOCK is unset; falling back to private key auth");
    return false;
  }
  return hasAgentSocket;
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

  private async getManagedVmNamesFromState(
    statePath?: string
  ): Promise<Set<string> | null> {
    try {
      const stateArgument = statePath ? ` -state="${statePath}"` : "";
      const { stdout } = await execAsync(`terraform state list${stateArgument}`, {
        cwd: this.terraformDir,
        env: this.getTerraformEnv(),
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120000,
      });
      return parseManagedVmNamesFromTerraformStateList(stdout || "");
    } catch (error: any) {
      logger.warn("Failed to reconcile terraform tfvars against current state", {
        error: error?.message || String(error),
      });
      return null;
    }
  }

  /**
   * Generate terraform variables file from config
   */
  private async generateTfVars(
    config: TerraformConfig,
    options: Pick<
      TerraformExecutionOptions,
      "tfvarsPath" | "baseTfvarsPath" | "statePath"
    > = {}
  ): Promise<string> {
    const sharedTfvarsPath = this.getTfvarsPath();
    const baseTfvarsPath = options.baseTfvarsPath || sharedTfvarsPath;
    const tfvarsPath = options.tfvarsPath || sharedTfvarsPath;
    let existingContent = "";
    try {
      existingContent = await readFile(baseTfvarsPath, "utf-8");
    } catch {
      existingContent = "";
    }

    // Get SSH public key
    const sshPublicKey = await this.getSshPublicKey(config);
    let baseTfvarsContent = existingContent;
    const managedVmNames = await this.getManagedVmNamesFromState(
      options.statePath
    );
    if (managedVmNames) {
      const { reconciledVmConfigs, removedVmNames } = reconcileVmConfigsWithTerraformState(
        existingContent,
        managedVmNames,
        config.vmConfigs
      );
      if (removedVmNames.length > 0) {
        logger.warn("Pruned orphaned VM configs from terraform tfvars before apply", {
          removedVmNames,
          sharedTfvarsPath,
        });
      }

      const reconciledVmConfigsBlock = Object.entries(reconciledVmConfigs)
        .map(([name, cfg]) => formatVmConfigEntry(name, cfg))
        .join(",\n");

      const reconciledVlanIdValue = extractHclAssignmentNumber(existingContent, "vm_vlan_id");
      const reconciledVlanIdLine =
        typeof reconciledVlanIdValue === "number" ? `vm_vlan_id = ${reconciledVlanIdValue}\n` : "";
      const reconciledUseSshAgentValue = resolveUseSshAgentValue(existingContent);
      baseTfvarsContent = `# Generated by Palindrome Action Layer
vm_bridge = "${extractHclAssignmentString(existingContent, "vm_bridge") || "vmbr0"}"
${reconciledVlanIdLine}use_ssh_agent = ${reconciledUseSshAgentValue ? "true" : "false"}
ssh_public_key = "${extractHclAssignmentString(existingContent, "ssh_public_key") || sshPublicKey}"
ssh_username = "${extractHclAssignmentString(existingContent, "ssh_username") || "ops"}"
cloud_init_datastore = "${extractHclAssignmentString(existingContent, "cloud_init_datastore") || "local"}"
vm_template_id = ${extractHclAssignmentNumber(existingContent, "vm_template_id") || 8001}

vm_configs = {
${reconciledVmConfigsBlock}
}
`;
    }

    const mergedVmConfigs = mergeVmConfigsWithExistingTfvars(baseTfvarsContent, config.vmConfigs);
    const vmBridgeValue = config.vmBridge || extractHclAssignmentString(existingContent, "vm_bridge") || "vmbr0";
    const vlanIdValue = config.vlanId ?? extractHclAssignmentNumber(existingContent, "vm_vlan_id");
    const useSshAgentValue = resolveUseSshAgentValue(existingContent);
    const cloudInitDatastoreValue =
      config.cloudInitDatastore ||
      extractHclAssignmentString(existingContent, "cloud_init_datastore") ||
      "local";
    const sshUsernameValue =
      config.sshUsername ||
      extractHclAssignmentString(existingContent, "ssh_username") ||
      "ops";
    const vmTemplateIdValue =
      config.templateId ||
      extractHclAssignmentNumber(existingContent, "vm_template_id") ||
      8001;

    // Build vm_configs block
    const vmConfigsBlock = Object.entries(mergedVmConfigs)
      .map(([name, cfg]) => formatVmConfigEntry(name, cfg))
      .join(",\n");

    // Generate new content
    const vlanIdLine = typeof vlanIdValue === "number" ? `vm_vlan_id = ${vlanIdValue}\n` : "";
    const newContent = `# Generated by Palindrome Action Layer
vm_bridge = "${vmBridgeValue}"
${vlanIdLine}use_ssh_agent = ${useSshAgentValue ? "true" : "false"}
ssh_public_key = "${sshPublicKey}"
ssh_username = "${sshUsernameValue}"
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

  async persistTfVars(config: TerraformConfig): Promise<string> {
    return this.generateTfVars(config);
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
    const useSshAgentValue = resolveUseSshAgentValue(existingContent);
    const sshPublicKey =
      extractHclAssignmentString(existingContent, "ssh_public_key") ||
      (await this.getSshPublicKey({}));
    const cloudInitDatastoreValue =
      extractHclAssignmentString(existingContent, "cloud_init_datastore") || "local";
    const sshUsernameValue =
      extractHclAssignmentString(existingContent, "ssh_username") || "ops";
    const vmTemplateIdValue =
      extractHclAssignmentNumber(existingContent, "vm_template_id") || 8001;

    const vmConfigsBlock = Object.entries(existingVmConfigs)
      .map(([name, cfg]) => formatVmConfigEntry(name, cfg))
      .join(",\n");
    const vlanIdLine = typeof vlanIdValue === "number" ? `vm_vlan_id = ${vlanIdValue}\n` : "";
    const updatedContent = `# Generated by Palindrome Action Layer
vm_bridge = "${vmBridgeValue}"
${vlanIdLine}use_ssh_agent = ${useSshAgentValue ? "true" : "false"}
ssh_public_key = "${sshPublicKey}"
ssh_username = "${sshUsernameValue}"
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

  async removeVmFromState(
    vmName: string,
    statePath?: string
  ): Promise<{ removed: string[]; missing: string[] }> {
    const stateArgs = ["list"];
    if (statePath) stateArgs.push(`-state="${statePath}"`);
    const stateListResult = await this.executeTerraform("state", stateArgs);
    const targets = getTerraformStateRemovalTargets(
      vmName,
      stateListResult.success ? stateListResult.stdout : ""
    );
    const removed: string[] = [];
    const missing: string[] = [];

    for (const target of targets) {
      const args = ["rm"];
      if (statePath) args.push(`-state="${statePath}"`);
      args.push(`'${target}'`);
      const result = await this.executeTerraform("state", args);
      const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
      if (/No matching objects found/i.test(output)) {
        missing.push(target);
      } else if (result.success) {
        removed.push(target);
      } else {
        throw new Error(`Failed to remove ${target} from Terraform state: ${result.stderr}`);
      }
    }

    logger.info("Terraform state cleanup for destroyed VM completed", {
      vmName,
      removed,
      missing,
    });
    return { removed, missing };
  }

  async reconcileStateRemovalArtifacts(
    options: Pick<TerraformExecutionOptions, "tfvarsPath" | "statePath"> = {}
  ): Promise<TerraformOutput> {
    const refreshResult = await this.refresh(undefined, options);
    if (!refreshResult.success) {
      throw new Error(`Failed to refresh Terraform outputs: ${refreshResult.stderr}`);
    }

    const outputs = await this.getOutputs(options.statePath);
    const inventoryPath = join(this.terraformDir, "..", "ansible", "inventory.ini");
    await writeFile(inventoryPath, renderAnsibleInventory(outputs), "utf-8");
    logger.info("Reconciled Terraform outputs and Ansible inventory after state cleanup", {
      inventoryPath,
      vmNames: Object.keys(outputs.vm_hostnames || outputs.vm_info || {}).sort(),
    });
    return outputs;
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

    const { proxmoxUrl, tokenId, tokenSecret } = resolveTerraformProxmoxAuth(targetNode);

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
  async plan(config: TerraformConfig, options: TerraformExecutionOptions = {}): Promise<TerraformResult> {
    const skipLock = options.skipLock ?? true;
    const targets = options.targets ?? [];
    const tfvarsPath = await this.generateTfVars(config, options);

    const args = [
      `-var-file="${tfvarsPath}"`,
      `-out="${options.planPath || "tfplan"}"`,
      "-input=false", // Non-interactive mode
    ];
    if (options.statePath) {
      args.push(`-state="${options.statePath}"`);
    }

    // For dry-run (plan), skip lock since it's read-only
    if (skipLock) {
      args.push("-lock=false");
    }

    for (const target of targets) {
      args.push(formatTerraformTargetArg(target));
    }

    return this.executeTerraform("plan", args);
  }

  /**
   * Run terraform apply
   */
  async apply(config: TerraformConfig, options: TerraformExecutionOptions = {}): Promise<TerraformResult> {
    const targets = options.targets ?? [];
    const tfvarsPath = await this.generateTfVars(config, options);

    const applyArgs = [
      `-var-file="${tfvarsPath}"`,
      "-auto-approve",
      "-input=false", // Non-interactive mode
      ...targets.map((target) => formatTerraformTargetArg(target)),
    ];
    if (options.statePath) {
      applyArgs.push(`-state="${options.statePath}"`);
    }
    const result = await this.executeTerraform("apply", applyArgs);

    // Refresh state and get outputs
    if (result.success) {
      await this.refresh(config, options);
      const outputs = await this.getOutputs(options.statePath);
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
  async refresh(
    config?: TerraformConfig,
    options: Pick<
      TerraformExecutionOptions,
      "tfvarsPath" | "baseTfvarsPath" | "statePath"
    > = {}
  ): Promise<TerraformResult> {
    if (config) {
      await this.generateTfVars(config, options);
    }
    const tfvarsPath = options.tfvarsPath || this.getTfvarsPath();
    const args = [
      `-var-file="${tfvarsPath}"`,
      "-input=false",
    ];
    if (options.statePath) {
      args.push(`-state="${options.statePath}"`);
    }
    return this.executeTerraform("refresh", args);
  }

  /**
   * Get terraform outputs
   */
  async getOutputs(statePath?: string): Promise<TerraformOutput> {
    const args = ["-json"];
    if (statePath) args.push(`-state="${statePath}"`);
    const result = await this.executeTerraform("output", args);

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
