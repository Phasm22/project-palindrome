import { z } from "zod";
import { TerraformRunner, type TerraformConfig } from "../helpers/terraform-runner";
import { TwinSync } from "../helpers/twin-sync";
import { TwinQueryService } from "../../twin/api/twin-query-service";
import { pceLogger as logger } from "../../pce/utils/logger";
import { normalizeNodeId } from "../../parsers/compute/helpers";
import { checkTerraformEnv } from "../helpers/env-validator";
import { getNextAvailablePalindromeName, getRandomPalindromeName } from "../helpers/palindrome-names";
import { allocateVmId } from "../helpers/vm-id-allocator";
import { ProxmoxClient } from "../../tools/proxmox/client";
import { getProxmoxEndpointConfigs } from "../../tools/proxmox/config";
import { emitToolProgress } from "../../agent/event-bus";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Create VM Action Schema
 */
export const CreateVmSchema = z.object({
  name: z.string().optional(), // Optional: will generate palindrome name if not provided
  node: z.string().min(1, "Node name is required"),
  cores: z.number().int().positive().default(2),
  memory: z.number().int().positive().default(4096), // MB
  diskSize: z.string().default("20G"),
  sshPublicKey: z.string().optional(),
  sshUsername: z.string().min(1).optional(),
  vmBridge: z.string().default("vmbr0"),
  vlanId: z.number().int().min(1).max(4094).optional(), // Optional: VLAN ID to assign (for vmbr0 tagging, or validation for pre-configured bridges)
  datastore: z.string().default("local-lvm"),
  cloudInitDatastore: z.string().optional(), // Optional: defaults to "local" in Terraform
  templateId: z.number().int().positive().optional(), // Optional: VM template ID to clone from (auto-discovered when omitted)
  vmId: z.number().int().positive().optional(), // Optional: Preferred VM ID (will check availability)
  bootstrap: z.boolean().default(false), // Optional: Run Ansible bootstrap (common.yml) after VM creation
  dryRun: z.boolean().default(false),
});

export type CreateVmParams = z.infer<typeof CreateVmSchema>;

export interface CreateVmResult {
  success: boolean;
  vmId?: string;
  hostname?: string;
  ipAddresses?: string[];
  message: string;
  terraformOutput?: any;
}

export function sanitizeVmName(input: string): string {
  const lower = input.toLowerCase().replace(/[_\s]+/g, "-");
  const cleaned = lower.replace(/[^a-z0-9-]/g, "");
  const trimmed = cleaned.replace(/^-+/, "").replace(/-+$/, "");
  return trimmed.substring(0, 63);
}

type ProxmoxVmListItem = {
  vmid?: number | string;
  name?: string;
  template?: number | boolean | string;
};

type ProxmoxNodeListItem = {
  node?: string;
  status?: string;
};

type ProxmoxStorageListItem = {
  storage?: string;
  enabled?: number | boolean | string;
  active?: number | boolean | string;
};

type ProxmoxNetworkListItem = {
  iface?: string;
  type?: string;
  active?: number | boolean | string;
};

export function parseTerraformPlanSummary(planOutput: string): { add: number; change: number; destroy: number } | null {
  const planMatch = planOutput.match(/Plan:\s*(\d+)\s+to add,\s*(\d+)\s+to change,\s*(\d+)\s+to destroy\./i);
  if (planMatch?.[1] && planMatch?.[2] && planMatch?.[3]) {
    return {
      add: Number.parseInt(planMatch[1], 10),
      change: Number.parseInt(planMatch[2], 10),
      destroy: Number.parseInt(planMatch[3], 10),
    };
  }
  if (/No changes\./i.test(planOutput)) {
    return { add: 0, change: 0, destroy: 0 };
  }
  return null;
}

export function extractTerraformVmDestroyTargets(planOutput: string): string[] {
  const targets = new Set<string>();
  const pattern =
    /#\s+(proxmox_virtual_environment_vm\.lab_vms\[[^\]]+\])\s+(will be destroyed|must be replaced)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(planOutput)) !== null) {
    const target = match[1];
    if (target) targets.add(target);
  }
  return Array.from(targets);
}

export function buildCreateVmTerraformTargets(vmName: string): string[] {
  return [
    `proxmox_virtual_environment_file.cloud_config["${vmName}"]`,
    `proxmox_virtual_environment_vm.lab_vms["${vmName}"]`,
    "null_resource.ansible_inventory",
  ];
}

export function parseTemplateCandidates(resources: unknown[]): Array<{ vmid: number; name: string }> {
  const templates: Array<{ vmid: number; name: string }> = [];
  for (const resource of resources) {
    const item = resource as ProxmoxVmListItem;
    const vmidRaw = item?.vmid;
    const vmid = typeof vmidRaw === "number" ? vmidRaw : Number(vmidRaw);
    if (!Number.isFinite(vmid) || vmid <= 0) continue;
    const templateFlag = item?.template;
    const isTemplate =
      templateFlag === true ||
      templateFlag === 1 ||
      templateFlag === "1" ||
      templateFlag === "true";
    if (!isTemplate) continue;
    templates.push({ vmid, name: String(item?.name || "") });
  }
  return templates;
}

export function rankTemplateCandidates(
  candidates: Array<{ vmid: number; name: string }>,
  preferredTemplateId?: number
): Array<{ vmid: number; name: string }> {
  const score = (entry: { vmid: number; name: string }): number => {
    const name = entry.name.toLowerCase();
    let points = 0;
    if (preferredTemplateId && entry.vmid === preferredTemplateId) points += 1000;
    if (name.includes("cloud")) points += 20;
    if (name.includes("ubuntu")) points += 15;
    if (name.includes("template")) points += 10;
    // favor lower IDs for stable infra conventions
    points -= entry.vmid / 10000;
    return points;
  };

  return [...candidates].sort((a, b) => score(b) - score(a));
}

function parseNodeCandidates(resources: unknown[]): string[] {
  const nodes = new Set<string>();
  for (const resource of resources) {
    const item = resource as ProxmoxNodeListItem;
    const name = typeof item.node === "string" ? item.node.trim() : "";
    if (!name) continue;
    nodes.add(name);
  }
  return Array.from(nodes);
}

export function parseDatastoreCandidates(resources: unknown[]): string[] {
  const storages = new Set<string>();
  for (const resource of resources) {
    const item = resource as ProxmoxStorageListItem;
    const name = typeof item.storage === "string" ? item.storage.trim() : "";
    if (!name) continue;
    const isEnabled = item.enabled === undefined || item.enabled === true || item.enabled === 1 || item.enabled === "1";
    const isActive = item.active === undefined || item.active === true || item.active === 1 || item.active === "1";
    if (!isEnabled || !isActive) continue;
    storages.add(name);
  }
  return Array.from(storages);
}

export function parseBridgeCandidates(resources: unknown[]): string[] {
  const bridges = new Set<string>();
  for (const resource of resources) {
    const item = resource as ProxmoxNetworkListItem;
    const iface = typeof item.iface === "string" ? item.iface.trim() : "";
    if (!iface) continue;
    const isBridge = item.type === "bridge" || iface.toLowerCase().startsWith("vmbr");
    if (!isBridge) continue;
    const isActive = item.active === undefined || item.active === true || item.active === 1 || item.active === "1";
    if (!isActive) continue;
    bridges.add(iface);
  }
  return Array.from(bridges);
}

export function rankStringCandidates(
  candidates: string[],
  preferredValue: string | undefined,
  priorityValues: string[]
): string[] {
  const preferred = preferredValue?.toLowerCase();
  const priorities = priorityValues.map((value) => value.toLowerCase());
  const unique = Array.from(new Set(candidates.map((value) => value.trim()).filter(Boolean)));
  return unique.sort((a, b) => {
    const score = (value: string): number => {
      const normalized = value.toLowerCase();
      let points = 0;
      if (preferred && normalized === preferred) points += 1000;
      const priorityIndex = priorities.indexOf(normalized);
      if (priorityIndex >= 0) points += 200 - priorityIndex;
      return points;
    };
    return score(b) - score(a);
  });
}

export function selectAvailableOption(params: {
  optionName: "datastore" | "bridge";
  preferredValue: string;
  availableValues: string[];
  priorityValues: string[];
  nodeName: string;
}): { value: string; warning?: string } {
  const { optionName, preferredValue, availableValues, priorityValues, nodeName } = params;
  if (availableValues.length === 0) {
    return { value: preferredValue };
  }

  const ranked = rankStringCandidates(availableValues, preferredValue, priorityValues);
  const preferredMatch = ranked.find((candidate) => candidate.toLowerCase() === preferredValue.toLowerCase());
  if (preferredMatch) {
    return { value: preferredMatch };
  }

  const fallback = ranked[0];
  if (!fallback) {
    throw new Error(`No usable ${optionName} options were discovered on node "${nodeName}".`);
  }

  return {
    value: fallback,
    warning: `${optionName} "${preferredValue}" is not available on node "${nodeName}". Using "${fallback}" instead. Available: ${ranked.join(", ")}.`,
  };
}

/**
 * Create VM Action
 * 
 * Validates using twin, generates terraform config, executes terraform,
 * and syncs results back to twin.
 */
/**
 * Get ProxmoxClient config for a specific node
 */
function getProxmoxClientConfig(node: string): { url: string; tokenId: string; tokenSecret: string } {
  const nodeLower = node.toLowerCase();
  const DEFAULT_NODE_URLS: Record<string, string> = {
    yang: "https://yang.prox:8006",
    yin: "https://yin.prox:8006",
  };
  
  let url: string;
  let tokenId: string | undefined;
  let tokenSecret: string | undefined;
  
  if (nodeLower === "yin" || nodeLower === "yang") {
    url = (nodeLower === "yin"
      ? process.env.PROXMOX_YIN_URL || process.env.PROXMOX_URL || DEFAULT_NODE_URLS.yin
      : process.env.PROXMOX_YANG_URL || process.env.PROXMOX_URL || DEFAULT_NODE_URLS.yang) as string;
    // Prefer node-specific TF token if provided; fall back to cluster token
    tokenId = nodeLower === "yin"
      ? process.env.PROXMOX_YIN_TF_TOKEN_ID || process.env.CLUSTER_TF_TOKEN_ID
      : process.env.PROXMOX_YANG_TF_TOKEN_ID || process.env.CLUSTER_TF_TOKEN_ID;
    if (nodeLower === "yin") {
      tokenSecret = process.env.PROXMOX_YIN_TF_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
    } else {
      tokenSecret = process.env.PROXMOX_YANG_TF_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
    }
  } else {
    url = process.env.PROXMOX_URL || "";
    tokenId = process.env.CLUSTER_TF_TOKEN_ID || process.env.PROXBIG_TF_TOKEN_ID;
    tokenSecret = process.env.PROXMOX_PROXBIG_TF_SECRET || process.env.PROXBIG_TF_SECRET || process.env.PROXBIG_TOKEN_SECRET || process.env.PROXMOX_CLUSTER_TF_SECRET;
  }
  
  if (!url || !tokenId || !tokenSecret) {
    throw new Error(`Missing Proxmox API configuration for node "${node}". Check environment variables.`);
  }
  
  return { url, tokenId, tokenSecret };
}

export async function createVm(params: CreateVmParams): Promise<CreateVmResult> {
  const { name, node, cores, memory, diskSize, sshPublicKey, sshUsername, vmBridge, vlanId, datastore, cloudInitDatastore, templateId, vmId: preferredVmId, bootstrap: shouldBootstrap, dryRun } = params;

  // Normalize node name: Proxmox node names are case-sensitive (YANG, yin, etc.)
  // Convert common lowercase inputs to correct case
  let normalizedNode = node;
  const nodeLower = node.toLowerCase();
  if (nodeLower === "yang") {
    normalizedNode = "YANG"; // Proxmox uses uppercase YANG
  } else if (nodeLower === "yin") {
    normalizedNode = "yin"; // yin is lowercase
  }
  // proxBig can be any case, keep as-is

  // Generate palindrome name if not provided, and sanitize to DNS-safe
  let finalName = name;
  if (!finalName || finalName.trim() === "") {
    try {
      const twinQuery = new TwinQueryService();
      const clusterInfo = await twinQuery.describeCluster();
      const allVmNames = clusterInfo.vms.map(vm => vm.name);
      await twinQuery.close();
      
      finalName = getNextAvailablePalindromeName(allVmNames);
      logger.info("Generated palindrome name for VM", { name: finalName, node: normalizedNode });
    } catch (error: any) {
      // Fallback to random palindrome if twin query fails
      finalName = getRandomPalindromeName();
      logger.warn("Failed to get existing VM names, using random palindrome", { 
        name: finalName, 
        error: error.message 
      });
    }
  }

  // Sanitize name to DNS-safe format: lowercase, alphanumerics and hyphens, max 63 chars, cannot start/end with hyphen
  const sanitizedName = sanitizeVmName(finalName);
  if (!sanitizedName) {
    return {
      success: false,
      message: `Invalid VM name "${finalName}". After sanitization it became empty. Please provide a name with letters, numbers, or hyphens.`,
    };
  }

  finalName = sanitizedName;

  logger.info("Creating VM", { name: finalName, node: normalizedNode, originalNode: node, cores, memory, diskSize, dryRun });

  // 0. Validate environment variables (cluster-aware)
  if (!checkTerraformEnv(normalizedNode)) {
    return {
      success: false,
      message: `Missing required environment variables for terraform operations on node "${normalizedNode}". Check logs for details.`,
    };
  }

  // 1. Twin-grounded validation (with live fallback when twin is stale)
  const twinQuery = new TwinQueryService();
  let nodeExists = false;
  let liveFallbackUsed = false;
  const liveNodeCandidates = new Set<string>();

  try {
    const clusterInfo = await twinQuery.describeCluster();
    const targetLower = normalizedNode.toLowerCase();
    const twinNodeMatch = clusterInfo.nodes.find((n) => n.name.toLowerCase() === targetLower);
    if (twinNodeMatch?.name) {
      nodeExists = true;
      normalizedNode = twinNodeMatch.name;
    }

    if (!nodeExists) {
      // Twin may be stale (e.g. ingestion only had one endpoint). Verify against live Proxmox.
      const configs = getProxmoxEndpointConfigs();
      for (const cfg of configs) {
        try {
          const client = new ProxmoxClient({
            url: cfg.url,
            tokenId: cfg.tokenId,
            tokenSecret: cfg.tokenSecret,
            verifySsl: cfg.verifySsl,
          });
          const res = await client.get("/nodes");
          const nodes: unknown[] = Array.isArray(res?.data?.data) ? res.data.data : [];
          const discoveredNodeNames = parseNodeCandidates(nodes);
          for (const discoveredNode of discoveredNodeNames) {
            liveNodeCandidates.add(discoveredNode);
          }
          const canonicalNode = discoveredNodeNames.find((nodeName) => nodeName.toLowerCase() === targetLower);
          if (canonicalNode) {
            nodeExists = true;
            liveFallbackUsed = true;
            normalizedNode = canonicalNode;
            logger.info("Node found on live Proxmox (twin missing this node)", {
              node: normalizedNode,
              endpoint: cfg.label ?? cfg.url,
            });
            break;
          }
        } catch (err: unknown) {
          logger.debug("Live node check failed for endpoint", {
            endpoint: cfg.label ?? cfg.url,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (!nodeExists) {
      const twinNodes = clusterInfo.nodes.map(n => n.name);
      const liveNodes = Array.from(liveNodeCandidates);
      return {
        success: false,
        message: `Node "${normalizedNode}" not found in twin or live Proxmox. Available nodes (twin): ${twinNodes.join(", ") || "none"}. Available nodes (live): ${liveNodes.join(", ") || "none"}. Run ingestion to sync the twin, or check PROXMOX_* / PROXBIG_* env.`,
      };
    }

    // Check if VM already exists
    // Use verifyAgainstProxmox: true to filter out stale Neo4j entries
    // If all VMs are filtered out (stale), proceed with creation
    const existingVms = await twinQuery.findVmByName(finalName, { verifyAgainstProxmox: true });
    if (existingVms.length > 0) {
      // Check if any of the verified VMs are actually on the target node
      const vmOnTargetNode = existingVms.find(vm => {
        const vmNode = vm.nodeName?.toLowerCase();
        const targetNodeLower = normalizedNode.toLowerCase();
        return vmNode === targetNodeLower || (targetNodeLower === "yang" && vmNode === "yang");
      });
      
      if (vmOnTargetNode) {
        return {
          success: false,
          message: `VM "${finalName}" already exists on node "${normalizedNode}" according to twin. Found: ${existingVms.map(vm => `${vm.name} on ${vm.nodeName || "unknown"}`).join(", ")}. If the VM was manually deleted, the twin may be stale. Run ingestion to sync the twin.`,
        };
      }
      // If VM exists on a different node, that's fine - we can create on this node
      logger.warn("VM exists on different node, proceeding with creation", { 
        name: finalName, 
        targetNode: normalizedNode,
        existingNodes: existingVms.map(vm => vm.nodeName || "unknown")
      });
    } else {
      // No verified VMs found - check if there were unverified (stale) entries
      // This helps with the case where verification filtered everything out
      const unverifiedVms = await twinQuery.findVmByName(finalName, { verifyAgainstProxmox: false });
      if (unverifiedVms.length > 0) {
        logger.info("Found stale VM entries in twin (filtered by verification), proceeding with creation", {
          name: finalName,
          staleCount: unverifiedVms.length,
          note: "These VMs don't exist in Proxmox - twin will be updated after creation",
        });
      }
    }
  } finally {
    await twinQuery.close();
  }

  const normalizedNodeLower = normalizedNode.toLowerCase();
  const selectionWarnings: string[] = [];

  // 1.5. Determine template ID with live discovery first, then defaults.
  let defaultTemplateId: number;
  if (normalizedNodeLower === "yang") defaultTemplateId = 8000;
  else if (normalizedNodeLower === "yin") defaultTemplateId = 8001;
  else defaultTemplateId = 8001;

  let discoveredTemplates: Array<{ vmid: number; name: string }> = [];
  let discoveredDatastores: string[] = [];
  let discoveredBridges: string[] = [];
  try {
    const proxmoxConfig = getProxmoxClientConfig(normalizedNode);
    const proxmoxClient = new ProxmoxClient({
      url: proxmoxConfig.url,
      tokenId: proxmoxConfig.tokenId,
      tokenSecret: proxmoxConfig.tokenSecret,
      verifySsl: process.env.PROXMOX_VERIFY_SSL !== "false",
    });

    const qemuResult = await proxmoxClient.get(`/nodes/${normalizedNode}/qemu`);
    const data = (qemuResult.data as { data?: unknown[] })?.data;
    discoveredTemplates = parseTemplateCandidates(Array.isArray(data) ? data : []);

    const storageResult = await proxmoxClient.get(`/nodes/${normalizedNode}/storage`);
    const storageData = (storageResult.data as { data?: unknown[] })?.data;
    discoveredDatastores = parseDatastoreCandidates(Array.isArray(storageData) ? storageData : []);

    const networkResult = await proxmoxClient.get(`/nodes/${normalizedNode}/network`);
    const networkData = (networkResult.data as { data?: unknown[] })?.data;
    discoveredBridges = parseBridgeCandidates(Array.isArray(networkData) ? networkData : []);
  } catch (error: any) {
    logger.warn("Proxmox option discovery failed; falling back to provided/default values", {
      node: normalizedNode,
      error: error?.message || String(error),
    });
  }

  const rankedTemplates = rankTemplateCandidates(discoveredTemplates, templateId || defaultTemplateId);
  let finalTemplateId: number;
  if (templateId) {
    finalTemplateId = templateId;
    if (rankedTemplates.length > 0 && !rankedTemplates.some((t) => t.vmid === templateId)) {
      const available = rankedTemplates.map((t) => `${t.vmid}${t.name ? ` (${t.name})` : ""}`).join(", ");
      return {
        success: false,
        message: `Template VM ${templateId} is not available on node "${normalizedNode}". Available templates on ${normalizedNode}: ${available}.`,
      };
    }
  } else if (rankedTemplates.length > 0) {
    const defaultMatch = rankedTemplates.find((t) => t.vmid === defaultTemplateId)?.vmid;
    const firstRanked = rankedTemplates[0]?.vmid;
    finalTemplateId = defaultMatch ?? firstRanked ?? defaultTemplateId;
  } else {
    finalTemplateId = defaultTemplateId;
  }

  logger.info("Using template ID", {
    templateId: finalTemplateId,
    node: normalizedNode,
    defaultTemplateId,
    wasProvided: !!templateId,
    discoveredTemplateIds: rankedTemplates.map((t) => t.vmid),
  });

  const datastoreSelection = selectAvailableOption({
    optionName: "datastore",
    preferredValue: datastore,
    availableValues: discoveredDatastores,
    priorityValues: ["local-lvm", "local", "snippets"],
    nodeName: normalizedNode,
  });
  const bridgeSelection = selectAvailableOption({
    optionName: "bridge",
    preferredValue: vmBridge,
    availableValues: discoveredBridges,
    priorityValues: ["vmbr0", "vmbr1", "vmbr2"],
    nodeName: normalizedNode,
  });

  const finalDatastore = datastoreSelection.value;
  const finalVmBridge = bridgeSelection.value;
  if (datastoreSelection.warning) {
    selectionWarnings.push(datastoreSelection.warning);
    logger.warn(datastoreSelection.warning);
  }
  if (bridgeSelection.warning) {
    selectionWarnings.push(bridgeSelection.warning);
    logger.warn(bridgeSelection.warning);
  }

  logger.info("Using infrastructure options", {
    node: normalizedNode,
    datastore: finalDatastore,
    vmBridge: finalVmBridge,
    requestedDatastore: datastore,
    requestedVmBridge: vmBridge,
    discoveredDatastores,
    discoveredBridges,
  });

  // 1.6. Allocate VM ID from high-number range (9000-9999)
  let allocatedVmId: number | undefined;
  try {
    const proxmoxConfig = getProxmoxClientConfig(normalizedNode);
    const proxmoxClient = new ProxmoxClient({
      url: proxmoxConfig.url,
      tokenId: proxmoxConfig.tokenId,
      tokenSecret: proxmoxConfig.tokenSecret,
      verifySsl: process.env.PROXMOX_VERIFY_SSL !== "false",
    });
    
    const allocationResult = await allocateVmId(proxmoxClient, {
      startId: 9000,
      endId: 9999,
      preferredId: preferredVmId,
      maxAttempts: 100,
    });
    
    if (allocationResult) {
      allocatedVmId = allocationResult.vmId;
      logger.info("Allocated VM ID", { 
        vmId: allocatedVmId, 
        usedPreferred: allocationResult.usedPreferred,
        attempts: allocationResult.attempts
      });
    } else {
      logger.warn("Could not allocate VM ID, Terraform will auto-assign", { 
        preferredVmId,
        range: "9000-9999"
      });
    }
  } catch (error: any) {
    logger.warn("Failed to allocate VM ID, Terraform will auto-assign", { 
      error: error.message,
      preferredVmId
    });
    // Continue without allocated ID - Terraform will auto-assign
  }

  // 2. Generate terraform config
  const terraformRunner = new TerraformRunner();
  terraformRunner.setTargetNode(normalizedNode); // Set target node for cluster-aware token selection
  
  // Get SSH public key
  let sshKey = sshPublicKey;
  if (!sshKey) {
    // Try to read from environment
    sshKey = process.env.SSH_PUBLIC_KEY || "";
    if (!sshKey) {
      // Terraform can read from ~/.ssh/id_ed25519.pub by default
      // So we'll let terraform handle it, but log a warning
      logger.warn("SSH_PUBLIC_KEY not set, terraform will attempt to read from ~/.ssh/id_ed25519.pub");
      // Don't fail - let terraform handle the error if the file doesn't exist
    }
  }

  // Determine cloud-init datastore based on node
  // yin/yang use "local" for snippets, proxBig uses "snippets" datastore
  const defaultCloudInitDatastore = (normalizedNodeLower === "yin" || normalizedNodeLower === "yang") ? "local" : "snippets";
  const selectionNoteText = selectionWarnings.length > 0
    ? ` Option adjustments: ${selectionWarnings.join(" ")}`
    : "";

  const tfConfig: TerraformConfig = {
    vmConfigs: {
      [finalName]: {
        target_node: normalizedNode, // Use normalized node name (uppercase YANG, lowercase yin)
        cores,
        memory,
        disk_size: diskSize,
        vm_id: allocatedVmId, // Use allocated VM ID, or undefined for auto-assign
      },
    },
    sshPublicKey: sshKey,
    sshUsername: (sshUsername && sshUsername.trim().length > 0) ? sshUsername.trim() : "ops",
    vmBridge: finalVmBridge,
    vlanId, // Optional VLAN ID for network tagging
    datastore: finalDatastore,
    cloudInitDatastore: cloudInitDatastore || defaultCloudInitDatastore,
    templateId: finalTemplateId, // Use the calculated template ID
  };

  // 3. Dry-run check
  const terraformTargets = buildCreateVmTerraformTargets(finalName);
  const tempTfvarsDir = await mkdtemp(join(tmpdir(), "palindrome-create-vm-"));
  const tempTfvarsPath = join(tempTfvarsDir, `${finalName}.tfvars`);

  try {
    if (dryRun) {
      const planResult = await terraformRunner.plan(tfConfig, {
        skipLock: true,
        targets: terraformTargets,
        tfvarsPath: tempTfvarsPath,
      });
      return {
        success: planResult.success,
        message: planResult.success
          ? `Dry-run successful. Would create VM "${finalName}" on node "${normalizedNode}"${allocatedVmId ? ` with VM ID ${allocatedVmId}` : ""} using bridge "${finalVmBridge}" and datastore "${finalDatastore}".${selectionNoteText}`
          : `Dry-run failed: ${planResult.stderr}`,
      };
    }

    // 4. Execute terraform
    // Safety gate: create_vm should never include destroys in plan.
    const preApplyPlan = await terraformRunner.plan(tfConfig, {
      skipLock: true,
      targets: terraformTargets,
      tfvarsPath: tempTfvarsPath,
    });
    if (!preApplyPlan.success) {
      throw new Error(`Terraform plan failed before apply: ${preApplyPlan.stderr || "unknown error"}`);
    }
    const planSummary = parseTerraformPlanSummary(preApplyPlan.stdout || "");
    const vmDestroyTargets = extractTerraformVmDestroyTargets(preApplyPlan.stdout || "");
    if (vmDestroyTargets.length > 0) {
      throw new Error(
        `Safety check blocked VM creation: Terraform plan would destroy/replace existing VM resources (${vmDestroyTargets.join(", ")}). ` +
        `This protects existing VMs from accidental deletion.`
      );
    }
    if ((planSummary?.destroy ?? 0) > 0) {
      logger.warn("Terraform plan includes destroy operations that do not target VM resources", {
        destroyCount: planSummary?.destroy ?? 0,
      });
    }

    logger.info("Executing terraform apply", { name: finalName, node: normalizedNode, vmId: allocatedVmId });
    // Progress: entering terraform apply (midpoint)
    emitToolProgress({
      toolName: "action",
      action: "compute.create_vm",
      status: "running",
      message: `Terraform apply for ${finalName} on ${normalizedNode}...`,
      progress: 0.5,
      details: { name: finalName, node: normalizedNode, vmId: allocatedVmId },
    });
    const applyResult = await terraformRunner.apply(tfConfig, {
      targets: terraformTargets,
      tfvarsPath: tempTfvarsPath,
    });

    if (!applyResult.success) {
    // Check for common errors and provide helpful messages
      const stderr = applyResult.stderr || "";
      let errorMessage = `Terraform apply failed: ${stderr}`;
      
      if (stderr.includes("403") || stderr.toLowerCase().includes("permission") || stderr.toLowerCase().includes("forbidden")) {
        errorMessage = `Terraform/Proxmox permission denied (HTTP 403). The Terraform token likely lacks VM.Allocate / PVEVMAdmin on node "${normalizedNode}". Grant the token (e.g., llm@pve!llm-agent) role PVEVMAdmin on / and /vms for ${normalizedNode}. Original error: ${stderr}`;
      } else
      if (stderr.includes("401") || stderr.includes("invalid token")) {
        errorMessage = `Terraform authentication failed. The token may not have permissions to write to the "snippets" datastore. ` +
          `Check that your Terraform token (${process.env.CLUSTER_TF_TOKEN_ID || process.env.PROXBIG_TF_TOKEN_ID}) has: ` +
          `Datastore.Allocate, Datastore.AllocateTemplate, and VM.Allocate permissions. ` +
          `Original error: ${stderr}`;
      } else if (stderr.includes("timeout") || stderr.includes("Still creating")) {
        errorMessage = `Terraform operation timed out or is taking too long. This may indicate network issues or insufficient permissions. ` +
          `Check the Proxmox API connectivity and token permissions. Original error: ${stderr}`;
      } else if (
        stderr.includes("storage 'snippets' does not exist") ||
        stderr.toLowerCase().includes("datastore snippets")
      ) {
        errorMessage = `Cloud-init snippets datastore is not available on node "${normalizedNode}". ` +
          `Set compute.create_vm cloudInitDatastore to a valid datastore for this node (for example "local"), or provision a snippets-capable datastore. ` +
          `Original error: ${stderr}`;
      } else if (
        /unable to find configuration file for VM\s+\d+/i.test(stderr) ||
        /template vm \d+ not found/i.test(stderr) ||
        /vm \d+ does not exist/i.test(stderr)
      ) {
        const available = rankedTemplates.length > 0
          ? rankedTemplates.map((t) => `${t.vmid}${t.name ? ` (${t.name})` : ""}`).join(", ")
          : "none discovered";
        errorMessage = `Template VM ${finalTemplateId} not found on node "${normalizedNode}". ` +
          `Available templates on ${normalizedNode}: ${available}. ` +
          `Specify templateId explicitly if needed. Original error: ${stderr}`;
      }
      
      // Propagate as failure so the caller stops the chain
      throw new Error(errorMessage);
    }

    await terraformRunner.persistTfVars(tfConfig);

    // Progress: terraform apply finished, moving to outputs
    emitToolProgress({
      toolName: "action",
      action: "compute.create_vm",
      status: "running",
      message: `Terraform apply finished for ${finalName}, reading outputs...`,
      progress: 0.9,
      details: { name: finalName, node: normalizedNode, vmId: allocatedVmId },
    });

    // 5. Get VM info from terraform outputs
    const outputs = await terraformRunner.getOutputs();
    const vmInfo = outputs.vm_info?.[finalName];

    if (!vmInfo) {
      return {
        success: false,
        message: "VM created but could not retrieve VM info from terraform outputs",
        terraformOutput: outputs,
      };
    }

    // 6. Sync to twin (non-blocking - VM is created even if sync fails)
    try {
      const twinSync = new TwinSync();
      const syncResult = await twinSync.syncTerraformVms(outputs);
      logger.info("VM synced to twin", { 
        name: finalName, 
        entities: syncResult.entities, 
        relationships: syncResult.relationships 
      });
    } catch (error: any) {
      logger.warn("Failed to sync VM to twin (non-critical)", { 
        error: error.message, 
        name: finalName,
        stack: error.stack 
      });
      // Don't fail VM creation if twin sync fails
    }

    // 7. Create DNS record if IP is available (non-blocking)
    // Flatten nested arrays and filter out localhost/pending IPs
    const ipAddresses = Array.isArray(vmInfo.ip_addresses) ? vmInfo.ip_addresses : [];
    const flattenedIps = ipAddresses
      .flat(2) // Flatten nested arrays (e.g., [["127.0.0.1"],["172.16.0.37"]] -> ["127.0.0.1", "172.16.0.37"])
      .filter((ip): ip is string => {
        if (typeof ip !== "string") return false;
        if (ip === "IP pending...") return false;
        if (ip.startsWith("127.")) return false; // Skip localhost
        if (ip.startsWith("::1")) return false; // Skip IPv6 localhost
        return true;
      });
    const firstIp = flattenedIps.length > 0 ? flattenedIps[0] : null;
    
    if (firstIp && (process.env.PIHOLE_WEB_PWD || process.env.PIHOLE_API_KEY)) {
      try {
        const { createDnsRecord } = await import("../network/create-dns-record");
        const dnsResult = await createDnsRecord({
          hostname: finalName, // VM name (e.g., "test-vm")
          ip: firstIp,
          domain: ".prox", // Will create test-vm.prox → IP
          dryRun: false,
        });
        
        if (dnsResult.success) {
          logger.info("DNS record created automatically", {
            hostname: finalName,
            ip: firstIp,
            domain: dnsResult.record?.domain,
          });
        } else {
          logger.warn("Failed to create DNS record automatically", {
            hostname: finalName,
            ip: firstIp,
            error: dnsResult.message,
          });
        }
      } catch (error: any) {
        logger.warn("Failed to create DNS record (non-critical)", {
          hostname: finalName,
          ip: firstIp,
          error: error.message,
        });
        // Don't fail VM creation if DNS record creation fails
      }
    } else if (!firstIp) {
      logger.info("DNS record creation skipped - IP not yet available (guest agent may need time)", {
        hostname: finalName,
        ipAddresses,
      });
    } else if (!process.env.PIHOLE_API_KEY) {
      logger.debug("DNS record creation skipped - PIHOLE_API_KEY not set");
    }

    // 8. Run Ansible bootstrap if requested (non-blocking)
    let bootstrapResult: any = null;
    if (shouldBootstrap && !dryRun) {
      try {
        logger.info("Bootstrap requested, running Ansible bootstrap", { vmName: finalName });
        const { bootstrap } = await import("../services/bootstrap");
        bootstrapResult = await bootstrap({
          vmName: finalName,
          playbook: "common.yml",
          waitForVm: true,
          timeout: 300,
          retryOnFailure: true,
          maxRetries: 2,
          dryRun: false,
        });

        if (bootstrapResult.success) {
          logger.info("Bootstrap completed successfully", {
            vmName: finalName,
            tasksChanged: bootstrapResult.tasksChanged,
            tasksFailed: bootstrapResult.tasksFailed,
          });
        } else {
          logger.warn("Bootstrap failed (non-critical)", {
            vmName: finalName,
            errors: bootstrapResult.errors,
          });
        }
      } catch (error: any) {
        logger.warn("Failed to run bootstrap (non-critical)", {
          vmName: finalName,
          error: error.message,
        });
        // Don't fail VM creation if bootstrap fails
      }
    }

    const bootstrapMessage = bootstrapResult
      ? bootstrapResult.success
        ? ` Bootstrap completed: ${bootstrapResult.tasksChanged} task(s) changed.`
        : ` Bootstrap failed: ${bootstrapResult.message}`
      : "";

    logger.info("VM created successfully", {
      name: finalName,
      node: normalizedNode,
      vmId: vmInfo.id,
      hostname: vmInfo.hostname,
      ipAddresses,
      bootstrap: shouldBootstrap,
      datastore: finalDatastore,
      vmBridge: finalVmBridge,
      selectionWarnings,
    });

    const connectUsername = (sshUsername && sshUsername.trim().length > 0) ? sshUsername.trim() : "ops";
    const connectLine =
      firstIp ? ` Connect with: ssh ${connectUsername}@${firstIp}.` : "";

    return {
      success: true,
      vmId: vmInfo.id.toString(),
      hostname: vmInfo.hostname,
      ipAddresses,
      message: `VM "${finalName}" created successfully on node "${normalizedNode}"${allocatedVmId ? ` with VM ID ${allocatedVmId}` : ""}. Hostname: ${vmInfo.hostname}. Bridge: ${finalVmBridge}. Datastore: ${finalDatastore}.${firstIp ? ` DNS record created: ${finalName}.prox → ${firstIp}.` : ""}${connectLine}${bootstrapMessage}${selectionNoteText}`,
      terraformOutput: outputs,
    };
  } finally {
    await rm(tempTfvarsDir, { recursive: true, force: true });
  }
}
