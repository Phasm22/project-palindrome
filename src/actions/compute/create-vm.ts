import { z } from "zod";
import { TerraformRunner, type TerraformConfig } from "../helpers/terraform-runner";
import { TwinSync } from "../helpers/twin-sync";
import { TwinQueryService } from "../../twin/api/twin-query-service";
import { pceLogger as logger } from "../../pce/utils/logger";
import { normalizeNodeId } from "../../parsers/compute/helpers";
import { checkTerraformEnv } from "../helpers/env-validator";

/**
 * Create VM Action Schema
 */
export const CreateVmSchema = z.object({
  name: z.string().min(1, "VM name is required"),
  node: z.string().min(1, "Node name is required"),
  cores: z.number().int().positive().default(2),
  memory: z.number().int().positive().default(4096), // MB
  diskSize: z.string().default("20G"),
  sshPublicKey: z.string().optional(),
  vmBridge: z.string().default("vmbr0"),
  datastore: z.string().default("local-lvm"),
  cloudInitDatastore: z.string().optional(), // Optional: defaults to "local" in Terraform
  templateId: z.number().int().positive().optional(), // Optional: VM template ID to clone from (defaults: yang=8000, yin=8001, proxBig=8001)
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
export async function createVm(params: CreateVmParams): Promise<CreateVmResult> {
  const { name, node, cores, memory, diskSize, sshPublicKey, vmBridge, datastore, cloudInitDatastore, templateId, dryRun } = params;

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

  logger.info("Creating VM", { name, node: normalizedNode, originalNode: node, cores, memory, diskSize, dryRun });

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
    // Note: Twin may have stale entries, so we check Proxmox directly via twin
    // If twin says it exists but Proxmox doesn't, we'll proceed anyway (twin sync will fix it)
    const existingVms = await twinQuery.findVmByName(name, {});
    if (existingVms.length > 0) {
      // Check if any of the VMs are actually on the target node
      const vmOnTargetNode = existingVms.find(vm => {
        const vmNode = vm.nodeName?.toLowerCase();
        const targetNodeLower = normalizedNode.toLowerCase();
        return vmNode === targetNodeLower || (targetNodeLower === "yang" && vmNode === "yang");
      });
      
      if (vmOnTargetNode) {
        return {
          success: false,
          message: `VM "${name}" already exists on node "${normalizedNode}" according to twin. Found: ${existingVms.map(vm => `${vm.name} on ${vm.nodeName || "unknown"}`).join(", ")}. If the VM was manually deleted, the twin may be stale.`,
        };
      }
      // If VM exists on a different node, that's fine - we can create on this node
      logger.warn("VM exists on different node, proceeding with creation", { 
        name, 
        targetNode: normalizedNode,
        existingNodes: existingVms.map(vm => vm.nodeName || "unknown")
      });
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
      [name]: {
        target_node: normalizedNode, // Use normalized node name (uppercase YANG, lowercase yin)
        cores,
        memory,
        disk_size: diskSize,
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
        ? `Dry-run successful. Would create VM "${name}" on node "${normalizedNode}"`
        : `Dry-run failed: ${planResult.stderr}`,
    };
  }

  // 4. Execute terraform
  logger.info("Executing terraform apply", { name, node });
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
  const vmInfo = outputs.vm_info?.[name];

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
    await twinSync.syncTerraformVms(outputs);
  } catch (error: any) {
    logger.warn("Failed to sync VM to twin (non-critical)", { error: error.message, name });
    // Don't fail VM creation if twin sync fails
  }

  logger.info("VM created successfully", {
    name,
    node,
    vmId: vmInfo.id,
    hostname: vmInfo.hostname,
    ipAddresses: vmInfo.ip_addresses,
  });

  return {
    success: true,
    vmId: vmInfo.id.toString(),
    hostname: vmInfo.hostname,
    ipAddresses: Array.isArray(vmInfo.ip_addresses) ? vmInfo.ip_addresses : [],
    message: `VM "${name}" created successfully on node "${normalizedNode}". Hostname: ${vmInfo.hostname}`,
    terraformOutput: outputs,
  };
}

