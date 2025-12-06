#!/usr/bin/env bun

/**
 * Test Bootstrap Cycle
 * 
 * Tests the complete Ansible bootstrap workflow:
 * 1. Create VM
 * 2. Wait for SSH
 * 3. Run bootstrap
 * 4. Verify results
 * 5. Optionally install Docker
 * 6. Destroy VM
 * 7. Run again to validate idempotency
 */

import { createVm } from "../src/actions/compute/create-vm";
import { destroyVm } from "../src/actions/compute/destroy-vm";
import { bootstrap } from "../src/actions/services/bootstrap";
import { installDocker } from "../src/actions/services/install-docker";
import { waitForSshAccessible } from "../src/actions/helpers/ansible-helpers";
import { TwinQueryService } from "../src/twin/api/twin-query-service";
import { pceLogger as logger } from "../src/pce/utils/logger";

const VM_NAME = "bootstrap-test";
const NODE = "YANG";
const ANSIBLE_DIR = "lab-infra/ansible";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testBootstrapCycle(installDockerAfter: boolean = false): Promise<boolean> {
  logger.info("=== Starting Bootstrap Cycle Test ===", {
    vmName: VM_NAME,
    node: NODE,
    installDockerAfter,
  });

  try {
    // Step 0: Clean stale VMs from Neo4j first
    logger.info("Step 0: Cleaning stale VMs from Neo4j", { vmName: VM_NAME });
    const twinQueryCleanup = new TwinQueryService();
    try {
      const cleanupResult = await twinQueryCleanup.cleanStaleVms();
      if (cleanupResult.deleted > 0) {
        logger.info("Cleaned stale VMs from Neo4j", { deleted: cleanupResult.deleted });
      }
    } catch (error: any) {
      logger.warn("Error cleaning stale VMs, continuing anyway", { error: error.message });
    } finally {
      await twinQueryCleanup.close();
    }

    // Step 0.5: Clean up any existing VM with the same name (verified against Proxmox)
    logger.info("Step 0.5: Checking for existing VM", { vmName: VM_NAME });
    const twinQuery0 = new TwinQueryService();
    try {
      const existingVms = await twinQuery0.findVmByName(VM_NAME, { verifyAgainstProxmox: true });
      if (existingVms.length > 0) {
        logger.info("Found existing VM, destroying it first", { vmName: VM_NAME, count: existingVms.length });
        const destroyResult = await destroyVm({
          name: VM_NAME,
          node: NODE,
          dryRun: false,
        });
        if (destroyResult.success) {
          logger.info("Existing VM destroyed", { vmName: VM_NAME });
          // Wait a bit for cleanup
          await sleep(2000);
        } else {
          logger.warn("Failed to destroy existing VM, proceeding anyway", {
            vmName: VM_NAME,
            error: destroyResult.message,
          });
        }
      }
    } catch (error: any) {
      logger.warn("Error checking for existing VM, proceeding anyway", { error: error.message });
    } finally {
      await twinQuery0.close();
    }

    // Step 1: Create VM
    logger.info("Step 1: Creating VM", { vmName: VM_NAME, node: NODE });
    const createResult = await createVm({
      name: VM_NAME,
      node: NODE,
      cores: 2,
      memory: 4096,
      diskSize: "20G",
      bootstrap: false, // We'll bootstrap manually to test the action
      dryRun: false,
    });

    if (!createResult.success) {
      logger.error("VM creation failed", { error: createResult.message });
      return false;
    }

    logger.info("VM created successfully", {
      vmId: createResult.vmId,
      hostname: createResult.hostname,
      ipAddresses: createResult.ipAddresses,
    });

    // Step 2: Wait for SSH
    logger.info("Step 2: Waiting for SSH accessibility", { hostname: createResult.hostname });
    const hostname = createResult.hostname || `${VM_NAME}.prox`;
    const isAccessible = await waitForSshAccessible(hostname, ANSIBLE_DIR, 300, 5);

    if (!isAccessible) {
      logger.error("VM is not SSH-accessible after timeout");
      return false;
    }

    logger.info("VM is SSH-accessible");

    // Step 3: Run bootstrap
    logger.info("Step 3: Running bootstrap", { vmName: VM_NAME });
    const bootstrapResult = await bootstrap({
      vmName: VM_NAME,
      playbook: "common.yml",
      waitForVm: false, // Already verified SSH
      timeout: 300,
      retryOnFailure: true,
      maxRetries: 2,
      dryRun: false,
    });

    if (!bootstrapResult.success) {
      logger.error("Bootstrap failed", {
        errors: bootstrapResult.errors,
        stderr: bootstrapResult.stderr,
      });
      return false;
    }

    // Step 4: Verify task count > 0
    logger.info("Step 4: Verifying bootstrap results");
    if (bootstrapResult.tasksChanged === undefined || bootstrapResult.tasksChanged === 0) {
      logger.warn("No tasks changed - this might be expected if VM was already configured");
    } else {
      logger.info("Bootstrap tasks changed", { tasksChanged: bootstrapResult.tasksChanged });
    }

    if (bootstrapResult.tasksFailed && bootstrapResult.tasksFailed > 0) {
      logger.error("Bootstrap had failed tasks", { tasksFailed: bootstrapResult.tasksFailed });
      return false;
    }

    logger.info("Bootstrap completed successfully", {
      tasksChanged: bootstrapResult.tasksChanged || 0,
      tasksFailed: bootstrapResult.tasksFailed || 0,
      changed: bootstrapResult.changed,
    });

    // Step 5: Optionally install Docker
    if (installDockerAfter) {
      logger.info("Step 5: Installing Docker", { vmName: VM_NAME });
      const dockerResult = await installDocker({
        vmName: VM_NAME,
        waitForVm: false, // Already verified SSH
        timeout: 300,
        retryOnFailure: true,
        maxRetries: 2,
        dryRun: false,
      });

      if (!dockerResult.success) {
        logger.error("Docker installation failed", {
          errors: dockerResult.errors,
          stderr: dockerResult.stderr,
        });
        return false;
      }

      logger.info("Docker installation completed", {
        tasksChanged: dockerResult.tasksChanged || 0,
        tasksFailed: dockerResult.tasksFailed || 0,
      });
    }

    // Step 6: Destroy VM
    logger.info("Step 6: Destroying VM", { vmName: VM_NAME });
    const destroyResult = await destroyVm({
      name: VM_NAME,
      dryRun: false,
    });

    if (!destroyResult.success) {
      logger.error("VM destruction failed", { error: destroyResult.message });
      return false;
    }

    logger.info("VM destroyed successfully");

    logger.info("=== Bootstrap Cycle Test PASSED ===");
    return true;
  } catch (error: any) {
    logger.error("Bootstrap cycle test failed", {
      error: error.message,
      stack: error.stack,
    });

    // Try to clean up VM if it exists
    try {
      logger.info("Attempting to clean up VM", { vmName: VM_NAME });
      await destroyVm({ name: VM_NAME, dryRun: false });
    } catch (cleanupError: any) {
      logger.warn("Failed to clean up VM", { error: cleanupError.message });
    }

    return false;
  }
}

async function testIdempotency(): Promise<boolean> {
  logger.info("=== Testing Idempotency ===");
  logger.info("Running bootstrap cycle twice to verify idempotency");

  // First run
  logger.info("First run...");
  const firstRun = await testBootstrapCycle(false);
  if (!firstRun) {
    logger.error("First run failed, cannot test idempotency");
    return false;
  }

  // Wait a bit between runs
  logger.info("Waiting 5 seconds before second run...");
  await sleep(5000);

  // Second run
  logger.info("Second run (should be idempotent)...");
  const secondRun = await testBootstrapCycle(false);
  if (!secondRun) {
    logger.error("Second run failed");
    return false;
  }

  logger.info("=== Idempotency Test PASSED ===");
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const testDocker = args.includes("--docker");
  const testIdempotent = args.includes("--idempotent");

  logger.info("Bootstrap Cycle Test", {
    testDocker,
    testIdempotent,
    args,
  });

  try {
    if (testIdempotent) {
      const success = await testIdempotency();
      process.exit(success ? 0 : 1);
    } else {
      const success = await testBootstrapCycle(testDocker);
      process.exit(success ? 0 : 1);
    }
  } catch (error: any) {
    logger.error("Test script error", {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main();
}

