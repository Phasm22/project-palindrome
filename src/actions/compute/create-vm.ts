import { z } from "zod";
import { TerraformRunner, TerraformConfig } from "../helpers/terraform-runner";
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
  templateId: z.number().int().positive().optional(), // Optional: VM template ID to clone from (defaults to 9000)
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

  logger.info("Creating VM", { name, node, cores, memory, diskSize, dryRun });

  // 0. Validate environment variables (cluster-aware)
  if (!checkTerraformEnv(node)) {
    return {
      success: false,
      message: `Missing required environment variables for terraform operations on node "${node}". Check logs for details.`,
    };
  }

  // 1. Twin-grounded validation
  const twinQuery = new TwinQueryService();
  
  try {
    // Check if node exists
    const clusterInfo = await twinQuery.describeCluster("all");
    const nodeExists = clusterInfo.nodes.some((n) => 
      n.name.toLowerCase() === node.toLowerCase()
    );

    if (!nodeExists) {
      return {
        success: false,
        message: `Node "${node}" not found in twin. Available nodes: ${clusterInfo.nodes.map(n => n.name).join(", ")}`,
      };
    }

    // Check if VM already exists
    const existingVms = await twinQuery.findVmByName(name, "all");
    if (existingVms.length > 0) {
      return {
        success: false,
        message: `VM "${name}" already exists. Found: ${existingVms.map(vm => `${vm.name} on ${vm.nodeName}`).join(", ")}`,
      };
    }
  } finally {
    await twinQuery.close();
  }

  // 1.5. Validate template ID if provided (or use default)
  const finalTemplateId = templateId || 9000;
  logger.info("Using template ID", { templateId: finalTemplateId, node });

  // 2. Generate terraform config
  const terraformRunner = new TerraformRunner();
  terraformRunner.setTargetNode(node); // Set target node for cluster-aware token selection
  
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
  const nodeLower = node.toLowerCase();
  const defaultCloudInitDatastore = (nodeLower === "yin" || nodeLower === "yang") ? "local" : "snippets";

  const tfConfig: TerraformConfig = {
    vmConfigs: {
      [name]: {
        target_node: node,
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
        ? `Dry-run successful. Would create VM "${name}" on node "${node}"`
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
    } else if (stderr.includes("unable to find configuration file for VM") || stderr.includes("template")) {
      errorMessage = `Template VM ${finalTemplateId} not found on node "${node}". ` +
        `Please verify that template ${finalTemplateId} exists on ${node}, or specify a different template ID using the templateId parameter. ` +
        `Original error: ${stderr}`;
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

  // 6. Sync to twin
  const twinSync = new TwinSync();
  await twinSync.syncTerraformVms(outputs);

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
    message: `VM "${name}" created successfully on node "${node}". Hostname: ${vmInfo.hostname}`,
    terraformOutput: outputs,
  };
}

