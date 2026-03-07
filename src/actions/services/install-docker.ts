import { z } from "zod";
import { pceLogger as logger } from "../../pce/utils/logger";
import { bootstrap, BootstrapSchema, type BootstrapResult } from "./bootstrap";

/**
 * Install Docker Action Schema
 */
export const InstallDockerSchema = z.object({
  vmName: z.string().min(1, "VM name is required").describe("VM name to install Docker on (resolved via digital twin to obtain the SSH hostname)"),
  waitForVm: z.boolean().default(true).describe("Wait for SSH to become accessible before running the playbook (default: true)"),
  timeout: z.number().int().positive().default(300).describe("SSH wait timeout in seconds (default: 300)"),
  extraVars: z.record(z.string(), z.any()).optional().describe("Additional Ansible extra-vars to pass to the docker.yml playbook (optional)"),
  retryOnFailure: z.boolean().default(false).describe("Retry the playbook on failure (default: false)"),
  maxRetries: z.number().int().positive().default(1).describe("Maximum number of retry attempts when retryOnFailure is true (default: 1)"),
  dryRun: z.boolean().default(false).describe("Preview without executing the playbook (default: false)"),
});

export type InstallDockerParams = z.infer<typeof InstallDockerSchema>;

export type InstallDockerResult = BootstrapResult;

/**
 * Install Docker Action
 * 
 * Runs docker.yml playbook to install Docker CE, Docker Compose,
 * and Portainer on a VM.
 */
export async function installDocker(params: InstallDockerParams): Promise<InstallDockerResult> {
  logger.info("Install Docker action started", { vmName: params.vmName });

  // Delegate to bootstrap with docker.yml playbook
  return bootstrap({
    ...params,
    playbook: "docker.yml",
  });
}
