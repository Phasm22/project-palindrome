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
  vmBridge: z.string().default("vmbr0"),
  datastore: z.string().default("local-lvm"),
  cloudInitDatastore: z.string().optional(), // Optional: defaults to "local" in Terraform
  templateId: z.number().int().positive().optional(), // Optional: VM template ID to clone from (defaults: yang=8000, yin=8001, proxBig=8001)
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
  
  let url: string;
  let tokenId: string | undefined;
  let tokenSecret: string | undefined;
  
  if (nodeLower === "yin" || nodeLower === "yang") {
    url = nodeLower === "yin"
      ? process.env.PROXMOX_YIN_URL || process.env.PROXMOX_URL || ""
      : process.env.PROXMOX_YANG_URL || process.env.PROXMOX_URL || "";
    tokenId = process.env.CLUSTER_TF_TOKEN_ID;
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
  const { name, node, cores, memory, diskSize, sshPublicKey, vmBridge, datastore, cloudInitDatastore, templateId, vmId: preferredVmId, bootstrap: shouldBootstrap, dryRun } = params;

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

  // Generate palindrome name if not provided
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

  logger.info("Creating VM", { name: finalName, node: normalizedNode, originalNode: node, cores, memory, diskSize, dryRun });

  // 0. Validate environment variables (cluster-aware)
  if (!checkTerraformEnv(normalizedNode)) {
    return {
      success: false,
      message: `Missing required environment variables for terraform operations on node "${normalizedNode}". Check logs for details.`,
    };
  }

  // 1. Twin-grounded validation
  const twinQuery = new TwinQueryService();
  
  try {
    // Check if node exists
    const clusterInfo = await twinQuery.describeCluster();
    const nodeExists = clusterInfo.nodes.some((n) => 
      n.name.toLowerCase() === normalizedNode.toLowerCase()
    );

    if (!nodeExists) {
      return {
        success: false,
        message: `Node "${normalizedNode}" not found in twin. Available nodes: ${clusterInfo.nodes.map(n => n.name).join(", ")}`,
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

  // 1.5. Determine template ID (node-specific defaults for cluster nodes)
  // In Proxmox clusters, VM IDs must be unique across the cluster
  // yang uses template 8000, yin uses template 8001
  // Reuse nodeLower from normalization above
  let defaultTemplateId: number;
  if (nodeLower === "yang") {
    defaultTemplateId = 8000;
  } else if (nodeLower === "yin") {
    defaultTemplateId = 8001;
  } else {
    // proxBig or other nodes default to 8001
    defaultTemplateId = 8001;
  }
  
  const finalTemplateId = templateId || defaultTemplateId;
  logger.info("Using template ID", { templateId: finalTemplateId, node: normalizedNode, defaultTemplateId, wasProvided: !!templateId });

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
        preferredId,
        range: "9000-9999"
      });
    }
  } catch (error: any) {
    logger.warn("Failed to allocate VM ID, Terraform will auto-assign", { 
      error: error.message,
      preferredId
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
  const defaultCloudInitDatastore = (nodeLower === "yin" || nodeLower === "yang") ? "local" : "snippets";

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
    vmBridge,
    datastore,
    cloudInitDatastore: cloudInitDatastore || defaultCloudInitDatastore,
    templateId: finalTemplateId, // Use the calculated template ID
  };

  // 3. Dry-run check
  if (dryRun) {
    const planResult = await terraformRunner.plan(tfConfig);
    return {
      success: planResult.success,
      message: planResult.success
        ? `Dry-run successful. Would create VM "${finalName}" on node "${normalizedNode}"${allocatedVmId ? ` with VM ID ${allocatedVmId}` : ""}`
        : `Dry-run failed: ${planResult.stderr}`,
    };
  }

  // 4. Execute terraform
  logger.info("Executing terraform apply", { name: finalName, node: normalizedNode, vmId: allocatedVmId });
  const applyResult = await terraformRunner.apply(tfConfig);

  if (!applyResult.success) {
    // Check for common errors and provide helpful messages
    const stderr = applyResult.stderr || "";
    let errorMessage = `Terraform apply failed: ${stderr}`;
    
    if (stderr.includes("401") || stderr.includes("invalid token")) {
      errorMessage = `Terraform authentication failed. The token may not have permissions to write to the "snippets" datastore. ` +
        `Check that your Terraform token (${process.env.CLUSTER_TF_TOKEN_ID || process.env.PROXBIG_TF_TOKEN_ID}) has: ` +
        `Datastore.Allocate, Datastore.AllocateTemplate, and VM.Allocate permissions. ` +
        `Original error: ${stderr}`;
    } else if (stderr.includes("timeout") || stderr.includes("Still creating")) {
      errorMessage = `Terraform operation timed out or is taking too long. This may indicate network issues or insufficient permissions. ` +
        `Check the Proxmox API connectivity and token permissions. Original error: ${stderr}`;
    } else if (stderr.includes("unable to find configuration file for VM") || stderr.includes("template") || stderr.includes("does not exist")) {
      // Provide helpful error message with node-specific defaults
      const nodeLower = node.toLowerCase();
      const suggestedTemplateId = nodeLower === "yang" ? 8000 : nodeLower === "yin" ? 8001 : 8001;
      errorMessage = `Template VM ${finalTemplateId} not found on node "${normalizedNode}". ` +
        `In Proxmox clusters, VM IDs must be unique. ` +
        `Default template IDs: yang=8000, yin=8001, proxBig=8001. ` +
        `Please verify that template ${finalTemplateId} exists on ${normalizedNode}, or specify a different template ID using the templateId parameter. ` +
        (finalTemplateId === suggestedTemplateId ? `(Note: ${normalizedNode} defaults to template ${suggestedTemplateId})` : ``) +
        ` Original error: ${stderr}`;
    }
    
    return {
      success: false,
      message: errorMessage,
    };
  }

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
  });

  return {
    success: true,
    vmId: vmInfo.id.toString(),
    hostname: vmInfo.hostname,
    ipAddresses,
    message: `VM "${finalName}" created successfully on node "${normalizedNode}"${allocatedVmId ? ` with VM ID ${allocatedVmId}` : ""}. Hostname: ${vmInfo.hostname}${firstIp ? `. DNS record created: ${finalName}.prox → ${firstIp}` : ""}.${bootstrapMessage}`,
    terraformOutput: outputs,
  };
}

