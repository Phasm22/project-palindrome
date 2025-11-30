import { z } from "zod";
import { TerraformRunner } from "../helpers/terraform-runner";
import { TwinQueryService } from "../../twin/api/twin-query-service";
import { pceLogger as logger } from "../../pce/utils/logger";
import { checkTerraformEnv } from "../helpers/env-validator";

/**
 * Destroy VM Action Schema
 */
export const DestroyVmSchema = z.object({
  name: z.string().min(1, "VM name is required"),
  node: z.string().min(1, "Node name is required").optional(), // Optional: helps with validation
  dryRun: z.boolean().default(false),
});

export type DestroyVmParams = z.infer<typeof DestroyVmSchema>;

export interface DestroyVmResult {
  success: boolean;
  message: string;
  terraformOutput?: any;
}

/**
 * Destroy VM Action
 * 
 * Uses terraform destroy -target to remove a specific VM
 */
export async function destroyVm(params: DestroyVmParams): Promise<DestroyVmResult> {
  const { name, node, dryRun } = params;

  logger.info("Destroying VM", { name, node, dryRun });

  // 0. Validate environment variables
  if (node && !checkTerraformEnv(node)) {
    return {
      success: false,
      message: `Missing required environment variables for terraform operations on node "${node}". Check logs for details.`,
    };
  }

  // 1. Twin-grounded validation - verify VM exists (but don't fail if not found - proceed with Terraform destroy)
  const twinQuery = new TwinQueryService();
  let vmFoundInTwin = false;
  
  try {
    // Use verifyAgainstProxmox: false to avoid filtering out VMs that might have timing issues
    // We'll let Terraform handle the actual verification
    const existingVms = await twinQuery.findVmByName(name, { verifyAgainstProxmox: false });
    
    if (existingVms.length > 0) {
      vmFoundInTwin = true;
      
      // If node specified, verify it matches (but allow if nodeName is undefined - twin sync issue)
      if (node) {
        const nodeLower = node.toLowerCase();
        const vmOnNode = existingVms.find(vm => {
          const vmNode = vm.nodeName?.toLowerCase();
          return vmNode === nodeLower || (nodeLower === "yang" && vmNode === "yang") || vmNode === undefined;
        });
        if (!vmOnNode && existingVms.some(vm => vm.nodeName)) {
          // Log warning but proceed - Terraform will handle the actual verification
          logger.warn("VM found in twin but on different node, proceeding with destroy", {
            name,
            requestedNode: node,
            foundNodes: existingVms.map(vm => vm.nodeName || "unknown"),
          });
        }
      }

      const targetVm = existingVms[0];
      logger.info("Found VM to destroy in twin", { 
        name, 
        node: node || targetVm.nodeName || "unknown", 
        vmId: targetVm.id, 
        allVms: existingVms.map(v => ({ name: v.name, node: v.nodeName })) 
      });
    } else {
      logger.warn("VM not found in twin, proceeding with Terraform destroy anyway", {
        name,
        node,
        note: "VM may have been created outside of twin sync or twin may be stale",
      });
    }
  } catch (error: any) {
    logger.warn("Error checking twin for VM, proceeding with Terraform destroy", {
      name,
      error: error.message,
    });
  } finally {
    await twinQuery.close();
  }

  // 2. Execute terraform destroy with target
  // Note: The Proxmox Terraform provider automatically stops the VM before destroying it
  // If the VM is running, Terraform will stop it first, then destroy it
  const terraformRunner = new TerraformRunner();
  if (node) {
    terraformRunner.setTargetNode(node);
  }

  try {
    // Use terraform destroy -target to destroy specific VM resource
    // Format: -target='proxmox_virtual_environment_vm.lab_vms["vm-name"]'
    // Terraform requires quotes around the entire target expression
    const targetResource = `proxmox_virtual_environment_vm.lab_vms["${name}"]`;
    const cloudConfigTarget = `proxmox_virtual_environment_file.cloud_config["${name}"]`;

    if (dryRun) {
      logger.info("Dry run: Would destroy VM", { name, targetResource });
      return {
        success: true,
        message: `Dry run: Would destroy VM "${name}" using terraform destroy -target='${targetResource}' (VM will be stopped automatically if running)`,
      };
    }

    // Execute terraform destroy with targets
    // The Proxmox provider will automatically stop the VM if it's running before destroying it
    // Use single quotes around the target to handle the brackets properly
    // Include var-file to avoid prompting for variables
    const tfvarsPath = terraformRunner.getTfvarsPath();
    const destroyResult = await terraformRunner.executeTerraform("destroy", [
      `-var-file="${tfvarsPath}"`,
      `-target='${targetResource}'`,
      `-target='${cloudConfigTarget}'`,
      "-auto-approve",
      "-input=false",
    ]);

    if (!destroyResult.success) {
      const stderr = destroyResult.stderr || "";
      let errorMessage = `Terraform destroy failed: ${stderr}`;
      
      if (stderr.includes("Resource targeting is required")) {
        errorMessage = `VM "${name}" not found in Terraform state. It may have already been destroyed or was created outside of Terraform.`;
      } else if (stderr.includes("No such file or directory")) {
        errorMessage = `Terraform state file not found. The VM may have already been destroyed.`;
      }

      return {
        success: false,
        message: errorMessage,
        terraformOutput: destroyResult,
      };
    }

    return {
      success: true,
      message: `VM "${name}" has been successfully destroyed.`,
      terraformOutput: destroyResult,
    };

  } catch (error: any) {
    logger.error("Error destroying VM", { name, error: error.message });
    return {
      success: false,
      message: `Failed to destroy VM "${name}": ${error.message}`,
    };
  }
}

