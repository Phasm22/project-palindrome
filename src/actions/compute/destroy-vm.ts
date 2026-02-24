import { z } from "zod";
import { TerraformRunner } from "../helpers/terraform-runner";
import { TwinQueryService } from "../../twin/api/twin-query-service";
import { pceLogger as logger } from "../../pce/utils/logger";
import { checkTerraformEnv } from "../helpers/env-validator";
import { readFile, writeFile } from "fs/promises";
import type { DnsRecord } from "../../tools/pihole/client";

/**
 * Destroy VM Action Schema
 */
export const DestroyVmSchema = z.object({
  name: z.string().optional(), // Optional: can use vmId instead
  vmId: z.number().int().positive().optional(), // Optional: can use name instead
  node: z.string().min(1, "Node name is required").optional(), // Optional: helps with validation
  dryRun: z.boolean().default(false),
}).refine(
  (data) => data.name || data.vmId,
  {
    message: "Either 'name' or 'vmId' must be provided",
    path: ["name"],
  }
);

export type DestroyVmParams = z.infer<typeof DestroyVmSchema>;

export interface DestroyVmResult {
  success: boolean;
  message: string;
  terraformOutput?: any;
}

export function normalizeDestroyVmIdentifiers(rawName: string): {
  infraName: string;
  dnsDomain: string;
} {
  const trimmed = rawName.trim().replace(/\.$/, "");
  const infraName = trimmed.replace(/\.prox$/i, "");
  const dnsDomain = trimmed.toLowerCase().endsWith(".prox")
    ? trimmed
    : `${infraName}.prox`;
  return { infraName, dnsDomain };
}

/** Client interface for DNS cleanup (allows mocking in tests). */
export interface PiholeDnsClient {
  listDnsRecords(): Promise<DnsRecord[]>;
  deleteDnsRecord(domain: string, ip?: string): Promise<void>;
}

/**
 * Delete the Pi-hole DNS record for a destroyed VM. Uses case-insensitive domain
 * matching and verifies deletion by listing again. Exported for testing.
 */
export async function deleteDnsRecordForDestroyedVm(
  piholeClient: PiholeDnsClient,
  dnsDomain: string,
  vmName: string
): Promise<{ dnsRecordDeleted: boolean }> {
  const existingRecords = await piholeClient.listDnsRecords();
  const normalizedDomain = dnsDomain.toLowerCase().replace(/\.$/, "");
  const dnsRecord = existingRecords.find(
    (r) => r.domain.toLowerCase().replace(/\.$/, "") === normalizedDomain
  );

  if (!dnsRecord) {
    logger.warn("DNS record not found, skipping deletion", {
      domain: dnsDomain,
      vmName,
      availableRecords: existingRecords.map((r) => ({ domain: r.domain, ip: r.ip })).slice(0, 10),
      note: "DNS record may have already been deleted or never existed. Check available records above.",
    });
    return { dnsRecordDeleted: false };
  }

  await piholeClient.deleteDnsRecord(dnsRecord.domain, dnsRecord.ip);

  const recordsAfterDelete = await piholeClient.listDnsRecords();
  const stillExists = recordsAfterDelete.find(
    (r) =>
      r.domain.toLowerCase().replace(/\.$/, "") ===
      dnsRecord.domain.toLowerCase().replace(/\.$/, "")
  );

  if (stillExists) {
    logger.warn("DNS record deletion may have failed - record still exists", {
      domain: dnsRecord.domain,
      vmName,
      ip: dnsRecord.ip,
    });
  } else {
    logger.info("DNS record deleted automatically", {
      domain: dnsRecord.domain,
      vmName,
      ip: dnsRecord.ip,
    });
  }

  return { dnsRecordDeleted: true };
}

/**
 * Destroy VM Action
 * 
 * Uses terraform destroy -target to remove a specific VM
 */
export async function destroyVm(params: DestroyVmParams): Promise<DestroyVmResult> {
  let { name, vmId, node, dryRun } = params;

  logger.info("Destroying VM", { name, vmId, node, dryRun });

  // If name looks like a VM ID (numeric string), treat it as vmId instead
  if (name && /^\d+$/.test(name.trim()) && !vmId) {
    logger.info("Name appears to be a VM ID, converting", { name, vmId });
    vmId = parseInt(name.trim(), 10);
    name = undefined; // Clear name so we look it up from twin
  }

  // If VM ID provided but no name, look up the name from the twin
  let finalName = name;
  let finalNode = node;
  
  if (vmId && !name) {
    const twinQuery = new TwinQueryService();
    try {
      // Use verifyAgainstProxmox: false for destroy - we want to proceed even if twin is stale
      // The twin might have stale data, but Terraform state is the source of truth
      // If verification filters out the VM, we still want to try Terraform destroy
      const vms = await twinQuery.findVmById(vmId, { verifyAgainstProxmox: false });
      
      if (vms.length === 0) {
        // VM not in twin - might be stale or created outside Terraform
        // We can't proceed without a name - Terraform needs the VM name from tfvars
        logger.warn("VM not found in twin, cannot resolve name", {
          vmId,
          node,
          note: "VM may have already been destroyed or created outside Terraform. Please provide the VM name.",
        });
        
        return {
          success: false,
          message: `VM with ID ${vmId} not found in the digital twin. Please provide the VM name (e.g., "destroy vm <name>") or ensure the twin is synced. The VM may have already been destroyed.`,
        };
      }
      
      // If node was provided, filter by node
      let targetVm = vms[0];
      if (!targetVm) {
        // This shouldn't happen since we checked vms.length > 0, but TypeScript needs this
        return {
          success: false,
          message: `VM with ID ${vmId} not found in the digital twin.`,
        };
      }
      
      if (finalNode && vms.length > 1) {
        const nodeMatch = vms.find(vm => {
          const vmNode = vm.nodeName?.toLowerCase();
          const targetNodeLower = finalNode?.toLowerCase();
          return vmNode === targetNodeLower;
        });
        if (nodeMatch) {
          targetVm = nodeMatch;
          logger.info("Selected VM from multiple matches based on node", {
            vmId,
            node: finalNode,
            selected: { name: targetVm.name, node: targetVm.nodeName },
          });
        }
      }
      
      finalName = targetVm.name;
      if (!finalNode && targetVm.nodeName) {
        finalNode = targetVm.nodeName;
      }
      
      logger.info("Resolved VM ID to name", { vmId, name: finalName, node: finalNode, allMatches: vms.length });
      
      // If multiple matches and no node specified, warn but proceed with first match
      if (vms.length > 1 && !finalNode) {
        logger.warn("Multiple VMs found with same ID, using first match", {
          vmId,
          selected: { name: finalName, node: finalNode },
          allMatches: vms.map(vm => ({ name: vm.name, node: vm.nodeName })),
        });
      }
    } catch (error: any) {
      logger.error("Failed to look up VM by ID", { vmId, error: error.message });
      return {
        success: false,
        message: `Failed to look up VM with ID ${vmId}: ${error.message}`,
      };
    } finally {
      await twinQuery.close();
    }
  }

  if (!finalName) {
    return {
      success: false,
      message: "VM name is required. Could not resolve name from VM ID.",
    };
  }

  // 0. Validate environment variables
  if (finalNode && !checkTerraformEnv(finalNode)) {
    return {
      success: false,
      message: `Missing required environment variables for terraform operations on node "${finalNode}". Check logs for details.`,
    };
  }

  // 1. Twin-grounded validation - verify VM exists (but don't fail if not found - proceed with Terraform destroy)
  const twinQuery = new TwinQueryService();
  let vmFoundInTwin = false;
  
  try {
    // Use verifyAgainstProxmox: false to avoid filtering out VMs that might have timing issues
    // We'll let Terraform handle the actual verification
    let existingVms = await twinQuery.findVmByName(finalName, { verifyAgainstProxmox: false });
    if (existingVms.length === 0) {
      const { infraName, dnsDomain } = normalizeDestroyVmIdentifiers(finalName);
      const fallbacks = [infraName, dnsDomain]
        .filter((candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index);
      for (const fallbackName of fallbacks) {
        if (fallbackName.toLowerCase() === finalName.toLowerCase()) continue;
        existingVms = await twinQuery.findVmByName(fallbackName, { verifyAgainstProxmox: false });
        if (existingVms.length > 0) {
          logger.info("Resolved VM using fallback name during destroy lookup", {
            requestedName: finalName,
            fallbackName,
            matchCount: existingVms.length,
          });
          break;
        }
      }
    }
    
    if (existingVms.length > 0) {
      vmFoundInTwin = true;
      
      // If node specified, verify it matches (but allow if nodeName is undefined - twin sync issue)
      if (finalNode) {
        const nodeLower = finalNode.toLowerCase();
        const vmOnNode = existingVms.find(vm => {
          const vmNode = vm.nodeName?.toLowerCase();
          return vmNode === nodeLower || (nodeLower === "yang" && vmNode === "yang") || vmNode === undefined;
        });
        if (!vmOnNode && existingVms.some(vm => vm.nodeName)) {
          // Log warning but proceed - Terraform will handle the actual verification
          logger.warn("VM found in twin but on different node, proceeding with destroy", {
            name: finalName,
            requestedNode: finalNode,
            foundNodes: existingVms.map(vm => vm.nodeName || "unknown"),
          });
        }
      }

      const targetVm = existingVms[0];
      if (!targetVm) {
        // This shouldn't happen since we checked existingVms.length > 0, but TypeScript needs this
        logger.warn("VM found in twin but first entry is undefined", { name: finalName });
      } else {
        if (typeof targetVm.name === "string" && targetVm.name.trim().length > 0) {
          finalName = targetVm.name.trim();
        }
        // Update finalNode if we found it from twin
        if (!finalNode && targetVm.nodeName) {
          finalNode = targetVm.nodeName;
        }
        
        // If nodeName is still missing, try to extract from VM ID (format: compute-vm:node:vmid)
        if (!finalNode && targetVm.id) {
          const idParts = targetVm.id.split(":");
          if (idParts.length >= 2) {
            const nodeFromId = idParts[1];
            if (nodeFromId) {
              // Normalize node name (yang -> YANG, yin -> yin)
              if (nodeFromId.toLowerCase() === "yang") {
                finalNode = "YANG";
              } else if (nodeFromId.toLowerCase() === "yin") {
                finalNode = "yin";
              } else {
                finalNode = nodeFromId;
              }
              logger.info("Extracted node from VM ID", { vmId: targetVm.id, extractedNode: finalNode });
            }
          }
        }
        
        logger.info("Found VM to destroy in twin", { 
          name: finalName, 
          node: finalNode || targetVm.nodeName || "unknown", 
          vmId: targetVm.id, 
          allVms: existingVms.map(v => ({ name: v.name, node: v.nodeName })) 
        });
      }
    } else {
      logger.warn("VM not found in twin, proceeding with Terraform destroy anyway", {
        name: finalName,
        node: finalNode,
        note: "VM may have been created outside of twin sync or twin may be stale",
      });
    }
  } catch (error: any) {
    logger.warn("Error checking twin for VM, proceeding with Terraform destroy", {
      name: finalName,
      error: error.message,
    });
  } finally {
    await twinQuery.close();
  }

  // 2. Execute terraform destroy with target
  // Note: The Proxmox Terraform provider automatically stops the VM before destroying it
  // If the VM is running, Terraform will stop it first, then destroy it
  const terraformRunner = new TerraformRunner();
  
  // Normalize node name for Terraform (YANG, yin, proxBig)
  if (finalNode) {
    const nodeLower = finalNode.toLowerCase();
    if (nodeLower === "yang") {
      finalNode = "YANG"; // Proxmox uses uppercase YANG
    } else if (nodeLower === "yin") {
      finalNode = "yin"; // yin is lowercase
    }
    terraformRunner.setTargetNode(finalNode);
    logger.info("Set Terraform target node", { node: finalNode, original: node });
  } else {
    logger.warn("No node specified for destroy, Terraform will use default endpoint", { name: finalName });
  }

  try {
    const { infraName: terraformVmName, dnsDomain } = normalizeDestroyVmIdentifiers(finalName);
    if (!terraformVmName) {
      return {
        success: false,
        message: `Unable to determine Terraform VM name from "${finalName}".`,
      };
    }

    // Use terraform destroy -target to destroy specific VM resource
    // Format: -target='proxmox_virtual_environment_vm.lab_vms["vm-name"]'
    // Terraform requires quotes around the entire target expression
    const targetResource = `proxmox_virtual_environment_vm.lab_vms["${terraformVmName}"]`;
    const cloudConfigTarget = `proxmox_virtual_environment_file.cloud_config["${terraformVmName}"]`;

    if (dryRun) {
      logger.info("Dry run: Would destroy VM", { name: terraformVmName, targetResource });
      return {
        success: true,
        message: `Dry run: Would destroy VM "${terraformVmName}" using terraform destroy -target='${targetResource}' (VM will be stopped automatically if running)`,
      };
    }

    // For destroy, we need to ensure the tfvars file has the vm_id field if it's missing
    // Read existing tfvars, patch it if needed, then use it
    const tfvarsPath = terraformRunner.getTfvarsPath();
    try {
      let tfvarsContent = await readFile(tfvarsPath, "utf-8");
      
      // Check if the VM config in tfvars is missing vm_id
      // Look for the VM name in the config and check if vm_id is present
      const escapedName = terraformVmName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Match the VM config block: "vm-name" = { ... }
      const vmConfigRegex = new RegExp(
        `("${escapedName}"\\s*=\\s*\\{[\\s\\S]*?)(\\})`,
        'g'
      );
      
      const match = vmConfigRegex.exec(tfvarsContent);
      if (match && match[1]) {
        const configBlock = match[1];
        // Check if vm_id is already present
        if (!configBlock.includes('vm_id')) {
          // Add vm_id = 0 before the closing brace (with proper indentation)
          const indentation = configBlock.match(/\n(\s+)(?:target_node|cores|memory|disk_size)/)?.[1] || "    ";
          const patchedBlock = configBlock.trimEnd() + `\n${indentation}vm_id       = 0\n`;
          tfvarsContent = tfvarsContent.replace(
            new RegExp(`("${escapedName}"\\s*=\\s*\\{[\\s\\S]*?)(\\})`, 'g'),
            (fullMatch, before, closing) => {
              if (before.includes('vm_id')) {
                return fullMatch; // Already has vm_id, don't modify
              }
              return before.trimEnd() + `\n${indentation}vm_id       = 0\n${closing}`;
            }
          );
          await writeFile(tfvarsPath, tfvarsContent, "utf-8");
          logger.info("Patched tfvars file to add missing vm_id field", { name: terraformVmName });
        }
      }
    } catch (error: any) {
      // If we can't read/patch the tfvars file, log warning but continue
      // Terraform might still work if the resource exists in state
      logger.warn("Could not read or patch tfvars file, proceeding anyway", {
        path: tfvarsPath,
        error: error.message,
      });
    }

    // Execute terraform destroy with targets
    // The Proxmox provider will automatically stop the VM if it's running before destroying it
    // Use single quotes around the target to handle the brackets properly
    // Include var-file to avoid prompting for variables
    // Use -refresh=false to skip state refresh (avoids SSL errors during destroy)
    const destroyResult = await terraformRunner.executeTerraform("destroy", [
      `-var-file="${tfvarsPath}"`,
      `-target='${targetResource}'`,
      `-target='${cloudConfigTarget}'`,
      "-refresh=false", // Skip refresh to avoid SSL certificate errors during destroy
      "-auto-approve",
      "-input=false",
    ]);

    // Check if Terraform actually destroyed anything
    // Terraform returns success=true even when "No changes" - we need to check stdout
    const stdout = destroyResult.stdout || "";
    const stderr = destroyResult.stderr || "";
    
    // Check for "No changes" first - this means the VM doesn't exist in Terraform state
    if (stdout.includes("No changes") || stdout.includes("No objects need to be destroyed")) {
      logger.warn("VM not found in Terraform state", {
        name: terraformVmName,
        vmId,
        node: finalNode,
        note: "VM may have been created outside Terraform or already destroyed",
      });
      
      return {
        success: false,
        message: `VM "${terraformVmName}"${vmId ? ` (ID: ${vmId})` : ""} not found in Terraform state. It may have been created outside of Terraform or already destroyed. If the VM still exists in Proxmox, you may need to destroy it manually or import it to Terraform first.`,
        terraformOutput: destroyResult,
      };
    }

    if (!destroyResult.success) {
      let errorMessage = `Terraform destroy failed: ${stderr}`;
      
      if (stderr.includes("Resource targeting is required")) {
        errorMessage = `VM "${terraformVmName}" not found in Terraform state. It may have already been destroyed or was created outside of Terraform.`;
      } else if (stderr.includes("No such file or directory")) {
        errorMessage = `Terraform state file not found. The VM may have already been destroyed.`;
      }

      return {
        success: false,
        message: errorMessage,
        terraformOutput: destroyResult,
      };
    }

    // 8. Delete DNS record if VM was successfully destroyed (non-blocking)
    let dnsRecordDeleted = false;
    if (process.env.PIHOLE_WEB_PWD || process.env.PIHOLE_API_KEY) {
      try {
        const { getPiholeClient } = await import("../../tools/pihole/client");
        const piholeClient = getPiholeClient();
        const result = await deleteDnsRecordForDestroyedVm(piholeClient, dnsDomain, finalName ?? terraformVmName);
        dnsRecordDeleted = result.dnsRecordDeleted;
      } catch (error: any) {
        logger.warn("Failed to delete DNS record automatically (non-critical)", {
          vmName: terraformVmName,
          error: error.message,
        });
      }
    }

    try {
      await terraformRunner.removeVmFromState(terraformVmName);
    } catch (error: any) {
      logger.warn("Failed to remove destroyed VM from terraform state", {
        vmName: terraformVmName,
        tfvarsPath,
        error: error.message,
      });
    }

    try {
      const removed = await terraformRunner.removeVmFromTfvars(terraformVmName);
      if (!removed) {
        logger.warn("Destroyed VM was not present in tfvars vm_configs (nothing removed)", {
          vmName: terraformVmName,
          tfvarsPath,
        });
      }
    } catch (error: any) {
      logger.warn("Failed to remove destroyed VM from tfvars vm_configs", {
        vmName: terraformVmName,
        tfvarsPath,
        error: error.message,
      });
    }

    const dnsStatusMessage = process.env.PIHOLE_WEB_PWD || process.env.PIHOLE_API_KEY
      ? dnsRecordDeleted
        ? " DNS record deleted."
        : " DNS record not found or could not be deleted automatically."
      : "";
    return {
      success: true,
      message: `VM "${terraformVmName}"${vmId ? ` (ID: ${vmId})` : ""} has been successfully destroyed.${dnsStatusMessage}`,
      terraformOutput: destroyResult,
    };

  } catch (error: any) {
    logger.error("Error destroying VM", { name: finalName, error: error.message });
    return {
      success: false,
      message: `Failed to destroy VM "${finalName}": ${error.message}`,
    };
  }
}
