import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { pceLogger as logger } from "../../pce/utils/logger";
import { TwinQueryService } from "../../twin/api/twin-query-service";
import { AnsibleRunner } from "./ansible-runner";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Resolve VM name to Ansible hostname
 * Handles both VM names (e.g., "dad") and hostnames (e.g., "dad.prox")
 */
export async function resolveVmToHostname(vmName: string): Promise<{ hostname: string; vmName: string }> {
  // If already a hostname (contains .prox), use it directly
  if (vmName.includes(".prox")) {
    return { hostname: vmName, vmName: vmName.replace(".prox", "") };
  }

  // Otherwise, query twin to find VM and construct hostname
  const twinQuery = new TwinQueryService();
  const vms = await twinQuery.findVmByName(vmName, { verifyAgainstProxmox: false });

  if (vms.length === 0) {
    throw new Error(`VM "${vmName}" not found in digital twin. Ensure the VM exists and the twin is synced.`);
  }

  if (vms.length > 1) {
    logger.warn("Multiple VMs found with same name, using first match", {
      vmName,
      matches: vms.map(vm => ({ name: vm.name, node: vm.nodeName })),
    });
  }

  const vm = vms[0];
  if (!vm) {
    throw new Error(`VM "${vmName}" lookup returned no usable records.`);
  }
  const resolvedName = vm.name || vmName;
  const hostname = `${resolvedName}.prox`;

  return { hostname, vmName: resolvedName };
}

/**
 * Check if hostname exists in Ansible inventory
 */
export function hostnameInInventory(hostname: string, inventoryPath: string): boolean {
  if (!existsSync(inventoryPath)) {
    return false;
  }

  try {
    const inventoryContent = readFileSync(inventoryPath, "utf-8");
    // Check if hostname appears in inventory (as hostname or in ansible_host)
    return inventoryContent.includes(hostname) || inventoryContent.includes(`ansible_host=${hostname}`);
  } catch (error) {
    logger.error("Failed to read inventory file", { inventoryPath, error });
    return false;
  }
}

/**
 * Hybrid inventory refresh strategy:
 * 1. Check if hostname exists in inventory (on-demand)
 * 2. If not found, try to refresh inventory from Terraform
 * 3. If still not found, throw error
 */
export async function ensureHostnameInInventory(
  hostname: string,
  ansibleDir: string,
  terraformDir?: string
): Promise<void> {
  const inventoryPath = join(ansibleDir, "inventory.ini");

  // Step 1: Check if hostname already exists
  if (hostnameInInventory(hostname, inventoryPath)) {
    logger.debug("Hostname found in inventory", { hostname });
    return;
  }

  // Step 2: Try to refresh inventory from Terraform
  logger.info("Hostname not found in inventory, attempting to refresh from Terraform", { hostname });
  
  if (!terraformDir) {
    terraformDir = join(process.cwd(), "lab-infra", "terraform");
  }

  try {
    // Run terraform output to regenerate inventory
    // Note: This assumes Terraform outputs generate inventory format
    // If your setup uses a different method, adjust this
    const { stdout } = await execAsync("terraform output -json", {
      cwd: terraformDir,
      maxBuffer: 10 * 1024 * 1024,
    });

    // Parse Terraform outputs and check if VM exists
    const outputs = JSON.parse(stdout);
    const vmInfo = outputs?.vm_info?.value || outputs?.vm_info || {};
    
    // Check if our VM is in the outputs
    const vmName = hostname.replace(".prox", "");
    if (vmInfo[vmName]) {
      logger.info("VM found in Terraform outputs, inventory should be regenerated", { vmName, hostname });
      // Note: Actual inventory regeneration would happen via Terraform template
      // For now, we'll proceed and let Ansible handle the error if VM truly doesn't exist
    } else {
      logger.warn("VM not found in Terraform outputs", { vmName, hostname });
    }
  } catch (error: any) {
    logger.warn("Failed to refresh inventory from Terraform", {
      error: error.message,
      hostname,
      note: "Proceeding anyway - Ansible will handle the error if VM doesn't exist",
    });
  }

  // Step 3: Final check
  if (!hostnameInInventory(hostname, inventoryPath)) {
    throw new Error(
      `Hostname "${hostname}" not found in Ansible inventory. ` +
      `Ensure the VM exists in Terraform and the inventory has been generated. ` +
      `You may need to run: cd lab-infra/terraform && terraform refresh && terraform output`
    );
  }
}

/**
 * Wait for VM to be SSH-accessible
 * Uses Ansible ping module to check connectivity, with direct SSH fallback
 */
export async function waitForSshAccessible(
  hostname: string,
  ansibleDir: string,
  timeoutSeconds: number = 300,
  checkIntervalSeconds: number = 5
): Promise<boolean> {
  const ansibleRunner = new AnsibleRunner(ansibleDir);
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;
  let attempt = 0;

  logger.info("Waiting for VM to be SSH-accessible", {
    hostname,
    timeoutSeconds,
    checkIntervalSeconds,
  });

  while (Date.now() - startTime < timeoutMs) {
    attempt++;
    const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
    
    try {
      // Try Ansible ping first
      const isAccessible = await ansibleRunner.ping("inventory.ini", `--limit ${hostname}`);
      
      if (isAccessible) {
        logger.info("VM is now SSH-accessible (via Ansible ping)", { 
          hostname, 
          elapsedSeconds,
          attempts: attempt,
        });
        return true;
      }

      // If Ansible ping fails, try direct SSH check as fallback
      // This helps when inventory is stale but VM is actually accessible
      try {
        const sshResult = await execAsync(
          `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes ops@${hostname} "echo ok" 2>&1`,
          { timeout: 5000 }
        );
        
        if (sshResult.stdout.includes("ok") || sshResult.stderr === "") {
          logger.info("VM is SSH-accessible (via direct SSH check)", {
            hostname,
            elapsedSeconds,
            attempts: attempt,
            note: "Ansible inventory may need refresh, but SSH works",
          });
          return true;
        }
      } catch (sshError: any) {
        // SSH failed, continue with Ansible ping checks
        if (attempt % 6 === 0) { // Log every 30 seconds (6 attempts * 5 seconds)
          logger.debug("VM not yet SSH-accessible", {
            hostname,
            elapsedSeconds,
            remainingSeconds: timeoutSeconds - elapsedSeconds,
            attempts: attempt,
            ansiblePing: false,
            directSSH: false,
          });
        }
      }

      // Wait before next check
      await new Promise((resolve) => setTimeout(resolve, checkIntervalSeconds * 1000));
    } catch (error: any) {
      // Log error but continue retrying
      if (attempt % 6 === 0) {
        logger.debug("SSH check failed, will retry", {
          hostname,
          elapsedSeconds,
          error: error.message,
          attempts: attempt,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, checkIntervalSeconds * 1000));
    }
  }

  const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
  logger.error("Timeout waiting for VM to be SSH-accessible", {
    hostname,
    elapsedSeconds,
    timeoutSeconds,
    attempts: attempt,
  });

  return false;
}

/**
 * Verify VM is running before attempting Ansible operations
 */
export async function verifyVmIsRunning(vmName: string): Promise<boolean> {
  const twinQuery = new TwinQueryService();
  const vms = await twinQuery.findVmByName(vmName, { verifyAgainstProxmox: false });

  if (vms.length === 0) {
    return false;
  }

  const vm = vms[0];
  if (!vm) {
    return false;
  }
  return vm.state === "running";
}
